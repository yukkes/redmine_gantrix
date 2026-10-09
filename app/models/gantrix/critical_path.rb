# frozen_string_literal: true

# Total float (余裕日数, in working days) of every task, from the planned dates and
# "precedes" relations. A task whose float is 0 or less is on the critical path:
# delaying it delays the end of the project.
#
# The planned dates are taken as they are (no forward pass): the late finish of a task is
# the latest finish that still lets every successor start on its own late start, and the
# float is how far the task can slip until then (one pass in topological order). Relations on
# parent tasks apply to all leaves below them. Parents get the smallest float of their open leaves; closed tasks get none.
class Gantrix::CriticalPath
  def initialize(issues, relations, calendar)
    @calendar = calendar
    @by_id = issues.index_by(&:id)
    @children = Hash.new { |h, k| h[k] = [] }
    issues.each { |i| @children[i.parent_id] << i.id if @by_id.key?(i.parent_id) }
    @relations = relations
    @leaves = {}
  end

  # { issue_id => float in working days }, for tasks with both dates
  def floats
    leaves = @by_id.keys.select { |id| @children[id].empty? && dated?(id) }
    return {} if leaves.empty?

    finish = leaves.map { |id| @by_id[id].due_date }.max
    succ = Hash.new { |h, k| h[k] = [] }
    @relations.each do |r|
      leaves_of(r.issue_from_id).each do |a|
        leaves_of(r.issue_to_id).each { |b| succ[a] << [b, r.delay.to_i] if a != b }
      end
    end
    late = leaves.to_h { |id| [id, finish] }
    # successors first, so each late finish is final when its predecessors read it
    topological(leaves, succ).reverse_each do |a|
      succ[a].each do |b, delay|
        lf = @calendar.step(late_start(b, late[b]), -(1 + delay))
        late[a] = lf if lf < late[a]
      end
    end
    # closed tasks still constrain their successors, but have no float to show
    result = leaves.reject { |id| @by_id[id].closed? }.to_h { |id| [id, slack(@by_id[id].due_date, late[id])] }
    @by_id.each_key do |id|
      next if @children[id].empty?

      values = leaves_of(id).filter_map { |l| result[l] }
      result[id] = values.min if values.any?
    end
    result
  end

  private

  def dated?(id)
    @by_id[id].start_date && @by_id[id].due_date
  end

  def leaves_of(id)
    return [] unless @by_id.key?(id)

    @leaves[id] ||= begin
      kids = @children[id]
      if kids.empty?
        dated?(id) ? [id] : []
      else
        kids.flat_map { |k| leaves_of(k) }
      end
    end
  end

  # Kahn's algorithm. Redmine refuses circular relations, but tasks left on a cycle (as relations on
  # parents can make one) are added at the end rather than lost.
  def topological(leaves, succ)
    indegree = Hash.new(0)
    succ.each_value { |list| list.map(&:first).each { |b| indegree[b] += 1 } }
    queue = leaves.select { |id| indegree[id].zero? }
    order = []
    until queue.empty?
      a = queue.pop
      order << a
      succ[a].map(&:first).each do |b|
        indegree[b] -= 1
        queue << b if indegree[b].zero?
      end
    end
    order.size == leaves.size ? order : order + (leaves - order)
  end

  # latest start that keeps the task's working-day length when it finishes on +late_finish+
  def late_start(id, late_finish)
    i = @by_id[id]
    @calendar.step(late_finish, -(@calendar.working_days(i.start_date, i.due_date) - 1))
  end

  # working days between the planned finish and the late finish (negative when already late)
  def slack(due, late_finish)
    return 0 if due == late_finish

    n = @calendar.working_days([due, late_finish].min, [due, late_finish].max) - 1
    late_finish > due ? n : -n
  end
end
