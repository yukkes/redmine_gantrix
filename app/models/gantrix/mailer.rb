# frozen_string_literal: true

class Gantrix::Mailer < Mailer
  # the first argument is the recipient: Mailer uses it for the language of the mail
  def predecessor_done(user, issue, predecessor)
    redmine_headers 'Project' => issue.project.identifier, 'Issue-Id' => issue.id
    @user = user
    @issue = issue
    @predecessor = predecessor
    @issue_url = url_for(controller: 'issues', action: 'show', id: issue)
    @schedule_url = url_for(controller: 'gantrix', action: 'show', project_id: issue.project)
    mail to: user, subject: "[#{issue.project.name} - #{issue.tracker.name} ##{issue.id}] #{l(:mail_subject_gantrix_ready, subject: issue.subject)}"
  end
end
