# frozen_string_literal: true

# Gantrix::Period.focus must pick the same period as Gantrix.focusRange in core.js (docker/dev/checks/calendar.js
# has the same cases): bin/rails runner /seed/checks/period.rb
require_relative '../runner_setup'

today = Date.new(2026, 10, 9)
d = ->(s) { Date.iso8601(s) }
cases = [
  [%w[2021-12-01 2026-12-01 9999-12-31 0003-01-20], '2021-12-01 - 2026-12-01'],
  [%w[2026-01-05 2026-03-31 9999-12-31], '2026-01-05 - 2026-10-09'],
  [%w[2015-04-01 2016-03-31], '2015-04-01 - 2016-03-31'],
  [%w[1990-01-01 2026-10-01 2026-10-02], '2026-10-01 - 2026-10-09'],
  [[], '2026-10-09 - 2026-10-09'],
  [Array.new(180) { |i| format('%<y>d-%<m>02d-01', y: 2016 + (i / 12), m: (i % 12) + 1) }, '2024-04-09 - 2029-04-09']
]
bad = cases.filter_map do |list, want|
  got = Gantrix::Period.focus(list.map(&d), today).map(&:iso8601).join(' - ')
  "focus(#{list.first(4).join(', ')}) = #{got}, want #{want}" unless got == want
end
# without the five-year limit a long project keeps its whole period
long = Gantrix::Period.focus(cases.last[0].map(&d), today, max_span: nil).map(&:iso8601).join(' - ')
bad << "no limit: #{long}" unless long == '2016-01-01 - 2030-12-01'
puts bad
puts bad.empty? ? "PERIOD CHECKS OK (#{cases.size + 1})" : "PERIOD CHECKS FAILED: #{bad.size}"
