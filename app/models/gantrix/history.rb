# frozen_string_literal: true

# Rebuilds the planned values of a project's issues at a point in time from
# journals (and from redmine_issue_trash when it is installed), so baselines
# and EVM need no snapshot tables.
class Gantrix::History
  FIELDS = %w[start_date due_date estimated_hours done_ratio].freeze

  class << self
    # { issue_id => { 'start_date' =>, 'due_date' =>, 'estimated_hours' =>, 'done_ratio' =>, 'subject' =>, 'deleted' => bool } }
    def snapshot(project, at)
      key = ['gantrix_snapshot', project.id, at.to_i, Journal.maximum(:id).to_i, trash_stamp(project)]
      Rails.cache.fetch(key, expires_in: 12.hours) { build(project, at) }
    end

    def build(project, at)
      values = {}
      Gantrix::IssueRows.new(project.issues.where('created_on <= ?', at)).each do |i|
        values[i.id] = { 'start_date' => i.start_date, 'due_date' => i.due_date, 'estimated_hours' => i.estimated_hours,
                         'done_ratio' => i.done_ratio, 'subject' => i.subject, 'deleted' => false }
      end
      ids = values.keys
      if ids.any?
        JournalDetail.joins(:journal)
                     .where(journals: { journalized_type: 'Issue', journalized_id: ids })
                     .where('journals.created_on > ?', at)
                     .where(property: 'attr', prop_key: FIELDS)
                     .order('journals.created_on DESC, journals.id DESC, journal_details.id DESC')
                     .pluck('journals.journalized_id', :prop_key, :old_value)
                     .each { |issue_id, field, old| values[issue_id][field] = old }
      end
      trashed(project, at).each { |id, v| values[id] ||= v }
      values.transform_values { |v| typed(v) }
    end

    # Progress of a whole plan at many points in time at once: for each of +times+, the sum of
    # weight x done ratio / 100 over the issues in +weights+ ({ issue id => weight }), with the done
    # ratio each issue had then (0 before it was created or after it was deleted) - the same as
    # summing over snapshot(project, time) for every time, in one pass over the journals instead.
    # Journals are put into the intervals between the times by the database, so their timestamps
    # are never turned into Ruby objects.
    def progress(project, times, weights)
      return times.map { 0.0 } if times.empty? || weights.empty?

      desc = times.sort.reverse.uniq
      ratio = project.issues.pluck(:id, :done_ratio).to_h { |id, r| [id, r.to_i] }
      sum = weights.sum { |id, w| w * ratio.fetch(id, 0) }
      events = Hash.new { |h, k| h[k] = [] } # interval => [[issue id, done ratio before], ...] newest first
      issue_ids = project.issues.select(:id)
      JournalDetail.joins(:journal)
                   .where(journals: { journalized_type: 'Issue', journalized_id: issue_ids })
                   .where('journals.created_on > ?', desc.last).where(property: 'attr', prop_key: 'done_ratio')
                   .order(Arel.sql("#{interval_sql('journals.created_on', desc)}, journals.created_on DESC, journals.id DESC, journal_details.id DESC"))
                   .pluck(Arel.sql(interval_sql('journals.created_on', desc)), 'journals.journalized_id', :old_value)
                   .each { |k, id, old| events[k.to_i] << [id, old.to_i] }
      created = project.issues.where('created_on > ?', desc.last).pluck(Arel.sql(interval_sql('issues.created_on', desc)), :id)
                       .group_by { |k, _| k.to_i }.transform_values { |list| list.map(&:last) }
      sums = {}
      desc.each_with_index do |t, k|
        # back in time past every change made after t: the oldest change of an issue tells its value then
        events[k].each do |id, old|
          w = weights[id] or next
          sum += w * (old - ratio.fetch(id, 0))
          ratio[id] = old
        end
        Array(created[k]).each do |id|
          w = weights[id] or next
          sum -= w * ratio.fetch(id, 0)
          ratio[id] = 0
        end
        sums[t] = sum / 100.0
      end
      deleted = trashed_progress(project, desc, weights)
      times.map { |t| sums[t] + deleted[t] }
    end

    private

    # CASE expression numbering the interval a timestamp falls in: 0 after desc[0], 1 between desc[1]
    # and desc[0], ... (+desc+: times, newest first)
    def interval_sql(column, desc)
      conn = ActiveRecord::Base.connection
      whens = desc.each_with_index.map { |t, k| "WHEN #{column} > #{conn.quote(t.utc)} THEN #{k}" }
      "CASE #{whens.join(' ')} ELSE #{desc.size} END"
    end

    # the part of +progress+ from issues deleted later (redmine_issue_trash): few, so one by one
    def trashed_progress(project, desc, weights)
      sums = desc.to_h { |t| [t, 0.0] }
      return sums unless defined?(TrashedIssue)

      TrashedIssue.where(project_id: project.id).where('created_at > ?', desc.last).find_each do |trash|
        a = trash.attributes_json || {}
        w = weights[a['id'].to_i]
        next unless w && a['created_on'].present?

        created = Time.zone.parse(a['created_on'].to_s)
        changes = Array(a['journals']).filter_map do |j|
          d = Array(j['details']).select { |x| x['property'] == 'attr' && x['prop_key'] == 'done_ratio' }.min_by { |x| x['id'].to_i }
          d && j['created_on'] && [Time.zone.parse(j['created_on'].to_s), j['id'].to_i, d['old_value'].to_i]
        end
        changes.sort!
        desc.each do |t|
          next if t >= trash.created_at || t < created

          first_after = changes.detect { |at, _, _| at > t }
          sums[t] += w * (first_after ? first_after[2] : a['done_ratio'].to_i) / 100.0
        end
      end
      sums
    end

    # Issues deleted after `at` (redmine_issue_trash): rebuild them from the saved JSON.
    def trashed(project, at)
      return {} unless defined?(TrashedIssue)

      TrashedIssue.where(project_id: project.id).where('created_at > ?', at).each_with_object({}) do |t, h|
        a = t.attributes_json || {}
        next if a['created_on'].blank? || Time.zone.parse(a['created_on'].to_s) > at

        v = FIELDS.to_h { |f| [f, a[f]] }.merge('subject' => a['subject'], 'deleted' => true)
        Array(a['journals']).select { |j| j['created_on'] && Time.zone.parse(j['created_on'].to_s) > at }
                            .sort_by { |j| [Time.zone.parse(j['created_on'].to_s), j['id'].to_i] }.reverse_each do |j|
          Array(j['details']).select { |d| d['property'] == 'attr' && FIELDS.include?(d['prop_key']) }
                             .sort_by { |d| -d['id'].to_i }
                             .each { |d| v[d['prop_key']] = d['old_value'] }
        end
        h[a['id'].to_i] = v
      end
    end

    def trash_stamp(project)
      return 0 unless defined?(TrashedIssue)

      TrashedIssue.where(project_id: project.id).maximum(:id).to_i
    end

    def typed(v)
      {
        'start_date' => date(v['start_date']), 'due_date' => date(v['due_date']),
        'estimated_hours' => v['estimated_hours'].presence&.to_f, 'done_ratio' => v['done_ratio'].to_i,
        'subject' => v['subject'], 'deleted' => v['deleted']
      }
    end

    def date(value)
      return value if value.is_a?(Date)
      return nil if value.blank?

      Date.iso8601(value.to_s[0, 10])
    rescue ArgumentError
      nil
    end
  end
end
