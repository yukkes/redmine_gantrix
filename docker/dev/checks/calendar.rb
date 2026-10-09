# frozen_string_literal: true

# Gantrix::Calendar counts working days arithmetically; check it against walking day by day:
# bin/rails runner /seed/checks/calendar.rb
require_relative '../runner_setup'

# the plain definitions the calendar must agree with
def slow_working_days(cal, from, to)
  return 1 if to < from

  [(from..to).count { |d| cal.working_day?(d) }, 1].max
end

def slow_step(cal, date, n)
  dir = n.negative? ? -1 : 1
  n.abs.times do
    date += dir
    date += dir until cal.working_day?(date)
  end
  date
end

rng = Random.new(7)
failures = 0
checks = 0
calendars = {
  'Saturday and Sunday, Japanese holidays' => Gantrix::Calendar.new(non_working_wdays: [6, 7], source: 'jp'),
  'Sunday only, company holidays' => Gantrix::Calendar.new(non_working_wdays: [7], source: 'jp',
                                                           extra_holidays: [Date.new(2026, 8, 13), Date.new(2026, 8, 14), Date.new(2026, 12, 29)]),
  'no week days off, imported holidays' => Gantrix::Calendar.new(non_working_wdays: [], source: 'imported',
                                                                 imported: { Date.new(2026, 1, 1) => '元日', Date.new(2026, 5, 4) => 'みどりの日' }),
  'Friday and Saturday, no holidays' => Gantrix::Calendar.new(non_working_wdays: [5, 6], source: 'none')
}
calendars.each do |name, cal|
  bad = []
  1500.times do
    from = Date.new(2018, 1, 1) + rng.rand(4500)
    to = from + rng.rand(-5..400)
    checks += 1
    bad << "working_days(#{from}, #{to})" if cal.working_days(from, to) != slow_working_days(cal, from, to)
    n = rng.rand(-60..60)
    checks += 1
    bad << "step(#{from}, #{n})" if cal.step(from, n) != slow_step(cal, from, n)
  end
  # a whole year across holidays, and the years the holiday formula does not cover
  [[Date.new(2025, 12, 1), Date.new(2027, 1, 31)], [Date.new(1979, 12, 20), Date.new(1980, 1, 20)],
   [Date.new(2099, 12, 20), Date.new(2100, 1, 20)]].each do |from, to|
    checks += 1
    bad << "working_days(#{from}, #{to})" if cal.working_days(from, to) != slow_working_days(cal, from, to)
  end
  failures += bad.size
  puts bad.empty? ? "ok   #{name}" : "FAIL #{name}: #{bad.first(5).join(', ')}"
end

# dates far outside the holiday years (9999-12-31 for "no end", typos like year 3) are valid and quick
cal = calendars.values.first
t = Time.now
far = cal.working_days(Date.new(3, 1, 20), Date.new(9999, 12, 31))
back = cal.step(Date.new(9999, 12, 31), -(far - 1))
ms = ((Time.now - t) * 1000).round
checks += 1
ok = back == cal.next_working_day(Date.new(3, 1, 20)) && ms < 100
failures += 1 unless ok
puts "#{ok ? 'ok  ' : 'FAIL'} years 3 to 9999: #{far} working days, back to #{back} in #{ms} ms"

puts failures.zero? ? "CALENDAR CHECKS OK (#{checks})" : "CALENDAR CHECKS FAILED: #{failures} of #{checks}"
