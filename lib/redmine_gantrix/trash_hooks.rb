# frozen_string_literal: true

module RedmineGantrix
  # redmine_issue_trash restores an issue (same id) and then deletes its trash record, but it
  # does not bring back relations such as "precedes". When the record is deleted while the
  # issue exists again, recreate the saved relations whose other issue still exists.
  module TrashHooks
    extend ActiveSupport::Concern

    included do
      after_destroy :gantrix_restore_relations
    end

    private

    def gantrix_restore_relations
      data = attributes_json || {}
      issue = Issue.find_by(id: data['id'])
      return unless issue

      Array(data['relations']).each do |r|
        from = r['issue_from_id'].to_i
        to = r['issue_to_id'].to_i
        next unless Issue.where(id: [from, to]).count == 2
        next if IssueRelation.exists?(issue_from_id: from, issue_to_id: to)

        rel = IssueRelation.new(issue_from_id: from, issue_to_id: to, relation_type: r['relation_type'], delay: r['delay'])
        rel.init_journals(User.current)
        Rails.logger.info("[gantrix] relation not restored: #{rel.errors.full_messages.join(', ')}") unless rel.save
      end
    rescue StandardError => e
      Rails.logger.warn("[gantrix] restoring relations failed: #{e.class}: #{e.message}")
    end
  end
end
