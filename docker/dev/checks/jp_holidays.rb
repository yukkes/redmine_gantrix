# frozen_string_literal: true

# Calculated Japanese holidays against the Cabinet Office list (1955 onwards, fetched from CAO_URL, or the file
# given in HOLIDAY_CSV): bin/rails runner /seed/checks/jp_holidays.rb
require_relative '../runner_setup'

# the Cabinet Office calls substitute and in-between days "休日"; the calculation names them
SAME = { '休日' => %w[振替休日 国民の休日], '休日（祝日扱い）' => %w[天皇の即位の日 即位礼正殿の儀の行われる日],
         '体育の日（スポーツの日）' => %w[体育の日] }.freeze

bytes = if ENV['HOLIDAY_CSV'] then File.binread(ENV['HOLIDAY_CSV'])
        else
          begin
            Net::HTTP.get(URI(Gantrix::HolidaySource::CAO_URL))
          rescue StandardError => e
            puts "skipped: the Cabinet Office list cannot be fetched (#{e.class})"
            exit
          end
        end
official = Gantrix::HolidaySource.parse_csv(bytes)
years = official.keys.map(&:year).uniq.sort
bad = []
years.each do |y|
  calc = Gantrix::Calendar.jp_holidays(y)
  real = official.select { |d, _| d.year == y }
  (calc.keys | real.keys).sort.each do |d|
    a = calc[d]
    b = real[d]
    next if a == b || (a && b && SAME.fetch(b, []).include?(a))

    bad << "#{d} calculated #{a || '-'} / official #{b || '-'}"
  end
end
puts bad.first(20)
# far years have no holidays and do not fail (9999-12-31 for "no end", year 3 for a typo)
far = [3, 1948, 2151, 9999].sum { |y| Gantrix::Calendar.jp_holidays(y).size }
ok = bad.empty? && far.zero?
puts ok ? "JP HOLIDAYS OK (#{years.first}-#{years.last}, #{official.size} days)" : "JP HOLIDAYS FAILED: #{bad.size} days, #{far} in far years"
