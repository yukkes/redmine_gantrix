# frozen_string_literal: true

# Earned value of a project, computed from existing data only (no snapshot tables):
#
# - plan (budget, PV): a baseline rebuilt from journals (Gantrix::History), or the current plan
# - EV: budget x progress of each task at that time (progress also rebuilt from journals)
# - AC: logged time (time_entries) up to that day
#
# The unit is hours when tasks have estimated hours; otherwise working days of the planned
# period are the weight and AC (hours) cannot be compared, so CPI / EAC are left out.
# Deleted tasks (redmine_issue_trash) stay in the plan of a baseline taken before the deletion.
class Gantrix::Evm
  MAX_POINTS = 60

  def initialize(project, calendar: Gantrix::Calendar.from_settings, baseline: nil, now: Time.current)
    @project = project
    @calendar = calendar
    @baseline = baseline # { 'name' =>, 'at' => } or nil
    @now = now
    @today = now.to_date
  end

  def call
    issues = Gantrix::IssueRows.new(@project.issues).to_a
    parents = issues.filter_map(&:parent_id).to_set
    roots = root_map(issues)
    plan = plan_values(issues, parents)
    return empty if plan.empty?

    hours = plan.values.any? { |v| v[:est].to_f.positive? }
    plan.each_value { |v| v[:budget] = hours ? v[:est].to_f : @calendar.working_days(v[:s], v[:e]).to_f }
    plan.reject! { |_, v| v[:budget].zero? || v[:s].nil? || v[:e].nil? }
    return empty if plan.empty?

    # tasks with dates far from the rest (9999-12-31, year 3) would spread the plan over thousands of years;
    # a long project keeps all of its tasks (no five-year limit as for drawing the schedule)
    period = Gantrix::Period.focus(plan.values.flat_map { |v| [v[:s], v[:e]] }, @today, max_span: nil)
    excluded = plan.count { |_, v| v[:s] < period[0] || v[:e] > period[1] }
    plan.reject! { |_, v| v[:s] < period[0] || v[:e] > period[1] }
    return empty(excluded) if plan.empty?

    start = plan.values.pluck(:s).min
    finish = plan.values.pluck(:e).max
    bac = plan.values.sum { |v| v[:budget] }
    points = sample_dates(start, [finish, @today].max)
    pv = pv_series(plan, points + [@today])
    past = points.select { |d| d <= @today }
    ev = ev_series(plan, (past + [@today]).uniq)
    ac_by_day = hours ? TimeEntry.where(project_id: @project.id).group(:spent_on).sum(:hours) : {}
    series = points.map do |d|
      row = { date: d, pv: round(pv[d]) }
      if d <= @today
        row[:ev] = round(ev[d])
        row[:ac] = round(ac_by_day.sum { |day, h| day <= d ? h.to_f : 0 }) if hours
      end
      row
    end
    now = kpis(pv[@today], ev[@today], bac, hours, ac_by_day, start, finish)
    {
      unit: hours ? 'hours' : 'days', bac: round(bac), start: start, finish: finish, excluded: excluded,
      baseline: @baseline && { name: @baseline['name'], at: @baseline['at'] },
      series: series, now: now, phases: phases(plan, roots, issues)
    }
  end

  private

  def empty(excluded = 0)
    { unit: 'hours', bac: 0, series: [], now: nil, phases: [], excluded: excluded,
      baseline: @baseline && { name: @baseline['name'], at: @baseline['at'] } }
  end

  # { id => { s:, e:, est:, subject:, deleted: } } for leaf tasks
  def plan_values(issues, parents)
    if @baseline
      snap = Gantrix::History.snapshot(@project, Time.iso8601(@baseline['at']))
      snap.except(*parents)
          .transform_values { |v| { s: v['start_date'], e: v['due_date'], est: v['estimated_hours'], subject: v['subject'], deleted: v['deleted'] } }
    else
      issues.reject { |i| parents.include?(i.id) }.to_h do |i|
        [i.id, { s: i.start_date, e: i.due_date, est: i.estimated_hours, subject: i.subject, deleted: false }]
      end
    end
  end

  # weekly points (Fridays-or-the-end), plus today; at most MAX_POINTS
  def sample_dates(from, to)
    step = [((to - from).to_i / 7.0 / MAX_POINTS).ceil, 1].max * 7
    list = []
    d = from
    while d < to
      list << d
      d += step
    end
    (list + [to, @today].grep(from..to)).uniq.sort
  end

  # Planned value at each of +dates+ ({ date => value }). A task earns its budget evenly over its working
  # days, so the total is a piecewise linear function of the number of working days passed: one sweep over
  # the tasks' start and end points gives every date, instead of every task for every date.
  def pv_series(plan, dates)
    slope = Hash.new(0.0) # working-day count => change of the slope there
    steps = [] # tasks without a working day: the whole budget on the start date
    plan.each_value do |v|
      a = @calendar.working_days_through(v[:s] - 1)
      b = @calendar.working_days_through(v[:e])
      if b > a
        slope[a] += v[:budget] / (b - a)
        slope[b] -= v[:budget] / (b - a)
      else
        steps << [v[:s], v[:budget]]
      end
    end
    keys = slope.keys.sort
    steps.sort_by!(&:first)
    value = rate = 0.0
    last = keys.first
    k = 0
    step_sum = 0.0
    j = 0
    dates.uniq.sort.to_h do |d|
      w = @calendar.working_days_through(d)
      while k < keys.size && keys[k] <= w
        value += rate * (keys[k] - last)
        last = keys[k]
        rate += slope[keys[k]]
        k += 1
      end
      while j < steps.size && steps[j][0] <= d
        step_sum += steps[j][1]
        j += 1
      end
      [d, (last ? value + (rate * (w - last)) : 0.0) + step_sum]
    end
  end

  # Earned value at the end of each of +dates+ ({ date => value }): the budget times the progress each task
  # had then, rebuilt from journals for all dates in one pass. A task that did not exist yet, or was deleted
  # by then, counts as not done.
  def ev_series(plan, dates)
    times = dates.map { |d| d >= @today ? @now : (d + 1).in_time_zone.beginning_of_day }
    sums = Gantrix::History.progress(@project, times, plan.transform_values { |v| v[:budget] })
    dates.zip(sums).to_h
  end

  def kpis(pv, ev, bac, hours, ac_by_day, start, finish)
    ac = if hours
           ac_by_day.sum { |day, h| day <= @today ? h.to_f : 0 }
         end
    spi = pv.positive? ? ev / pv : nil
    cpi = ac&.positive? ? ev / ac : nil
    eac = cpi&.positive? ? bac / cpi : nil
    planned_days = @calendar.working_days(start, finish)
    forecast = if ev >= bac then nil
               elsif spi&.positive? then @calendar.step(@calendar.next_working_day(start), (planned_days / spi).ceil - 1)
               end
    {
      date: @today, pv: round(pv), ev: round(ev), ac: ac && round(ac), sv: round(ev - pv), cv: ac && round(ev - ac),
      spi: spi&.round(2), cpi: cpi&.round(2), eac: eac && round(eac), etc: eac && round(eac - ac), vac: eac && round(bac - eac),
      progress: bac.positive? ? (ev / bac * 100).round(1) : 0, planned_progress: bac.positive? ? (pv / bac * 100).round(1) : 0,
      finish: finish, forecast: forecast
    }
  end

  # the same numbers per top-level task (工程)
  def phases(plan, roots, issues)
    by_id = issues.index_by(&:id)
    groups = plan.group_by { |id, _| roots[id] || id }
    groups.map do |root, items|
      sub = items.to_h
      bac = sub.values.sum { |v| v[:budget] }
      pv = pv_series(sub, [@today])[@today]
      # progress now: from the issues; a task deleted since the baseline counts as not done
      ev = sub.sum { |id, v| v[:budget] * (by_id[id]&.done_ratio || 0) / 100.0 }
      {
        id: root, subject: by_id[root]&.subject || sub.values.first[:subject], bac: round(bac), pv: round(pv), ev: round(ev),
        spi: pv.positive? ? (ev / pv).round(2) : nil, progress: bac.positive? ? (ev / bac * 100).round(1) : 0,
        start: sub.values.map { |v| v[:s] }.min, finish: sub.values.map { |v| v[:e] }.max
      }
    end.sort_by { |p| [p[:start] || Date.new(9999), p[:id]] }
  end

  # top-level ancestor of every issue
  def root_map(issues)
    by_id = issues.index_by(&:id)
    issues.to_h do |i|
      r = i
      r = by_id[r.parent_id] while r.parent_id && by_id[r.parent_id]
      [i.id, r.id]
    end
  end

  def round(v)
    v.to_f.round(1)
  end
end
