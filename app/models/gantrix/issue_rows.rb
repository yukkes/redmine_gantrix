# frozen_string_literal: true

# The columns of issues the screens need, read as plain rows instead of Issue records: a project of
# tens of thousands of issues loads in a small part of the time and memory. Values are converted here
# (each distinct date once) rather than by Active Record, and timestamps are left out because turning
# them into Time objects costs more than everything else together. Names of statuses, trackers and
# assignees are looked up once per screen instead of once per issue.
class Gantrix::IssueRows
  COLUMNS = %i[id parent_id subject start_date due_date done_ratio estimated_hours status_id assigned_to_id
               tracker_id fixed_version_id author_id].freeze
  INTEGERS = %i[id parent_id done_ratio status_id assigned_to_id tracker_id fixed_version_id author_id].freeze

  Row = Struct.new(*COLUMNS, :closed) do
    def closed?
      closed
    end
  end

  include Enumerable

  # +scope+: an issue relation, such as project.issues.visible
  def initialize(scope)
    closed = IssueStatus.where(is_closed: true).pluck(:id).to_set
    sql = scope.reorder(nil).select(*COLUMNS.map { |c| Issue.arel_table[c] }).to_sql
    dates = Hash.new { |h, v| h[v] = to_date(v) }
    ints = INTEGERS.map { |c| COLUMNS.index(c) }
    s = COLUMNS.index(:start_date)
    e = COLUMNS.index(:due_date)
    h = COLUMNS.index(:estimated_hours)
    @rows = Issue.connection.select_rows(sql).map do |row_values|
      v = row_values.dup # SQLite returns frozen rows
      ints.each { |i| v[i] = v[i]&.to_i } # SQLite and MySQL may return numbers as strings
      v[s] = dates[v[s]] unless v[s].nil?
      v[e] = dates[v[e]] unless v[e].nil?
      v[h] = v[h]&.to_f
      row = Row.new(*v)
      row.closed = closed.include?(row.status_id)
      row
    end
  end

  def each(&block)
    @rows.each(&block)
  end

  delegate :size, to: :@rows

  def ids
    @rows.map(&:id)
  end

  def status_names
    @status_names ||= IssueStatus.pluck(:id, :name).to_h
  end

  def tracker_names
    @tracker_names ||= Tracker.pluck(:id, :name).to_h
  end

  # assignees (users or groups) by id
  def assignee_names
    @assignee_names ||= Principal.where(id: @rows.filter_map(&:assigned_to_id).uniq).to_h { |p| [p.id, p.name] }
  end

  private

  def to_date(value)
    value.is_a?(Date) ? value : Date.iso8601(value.to_s[0, 10])
  rescue ArgumentError
    nil
  end
end
