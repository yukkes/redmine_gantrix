# frozen_string_literal: true

# WBS structure of a set of issues: sibling order (position field, then start date, then id,
# the same as the schedule screen) and WBS numbers such as "2.3".
class Gantrix::Tree
  # +positions+: { issue_id => position } when the caller has read them already
  def initialize(issues, positions: nil)
    @by_id = issues.index_by(&:id)
    pos = positions || Gantrix::Positions.for(@by_id.keys)
    kids = Hash.new { |h, k| h[k] = [] }
    issues.each { |i| kids[@by_id.key?(i.parent_id) ? i.parent_id : nil] << i }
    @children = kids.transform_values do |list|
      list.sort_by { |i| [pos[i.id] || (1 << 30), i.start_date || Date.new(9999), i.id] }.map(&:id)
    end
    @wbs = {}
    number = lambda do |ids, prefix|
      ids.each_with_index do |id, n|
        @wbs[id] = "#{prefix}#{n + 1}"
        number.call(@children.fetch(id, []), "#{@wbs[id]}.")
      end
    end
    number.call(@children.fetch(nil, []), '')
  end

  def wbs(id)
    @wbs[id]
  end

  def leaf?(id)
    @children.fetch(id, []).empty?
  end

  # ids of the children in WBS order (+nil+: the top-level tasks)
  def children(id)
    @children.fetch(id, [])
  end

  # "2 基本設計 › 2.3": the top-level task and the task's own number
  def path(id)
    root = id
    root = @by_id[root].parent_id while @by_id[root]&.parent_id && @by_id.key?(@by_id[root].parent_id)
    return @wbs[id].to_s if root == id

    "#{@wbs[root]} #{@by_id[root].subject} › #{@wbs[id]}"
  end
end
