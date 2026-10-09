# frozen_string_literal: true

# WBS sibling order, kept in the hidden "position" issue custom field.
# Values are written directly to custom_values so that issue journals,
# updated_on and notifications are not affected.
class Gantrix::Positions
  class << self
    def for(issue_ids)
      return {} if issue_ids.empty?

      CustomValue.where(custom_field_id: Gantrix::Fields.id('cf_position'), customized_type: 'Issue', customized_id: issue_ids)
                 .where.not(value: [nil, ''])
                 .pluck(:customized_id, :value).to_h { |id, v| [id, v.to_i] }
    end

    # Write 10, 20, 30... for the given ordered ids.
    def write(ordered_ids)
      field_id = Gantrix::Fields.id('cf_position')
      current = CustomValue.where(custom_field_id: field_id, customized_type: 'Issue', customized_id: ordered_ids).index_by(&:customized_id)
      ordered_ids.each_with_index do |id, i|
        value = ((i + 1) * 10).to_s
        cv = current[id] || CustomValue.new(custom_field_id: field_id, customized_type: 'Issue', customized_id: id)
        next if cv.value == value

        cv.value = value
        cv.save!(validate: false)
      end
    end
  end
end
