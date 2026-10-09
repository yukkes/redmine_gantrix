// Browser checks that the recommended companion plugins load and work next to Gantrix (Playwright).
//   NODE_PATH=<dir with playwright>/node_modules node docker/dev/plugins_test.js 3006
// Needs the demo data (docker/dev/seed_demo.rb), which turns on every project module.
const { chromium } = require('playwright');

// the published port (3006) or the container's address (172.19.0.3:3000, as docker/dev/test_all.sh passes it)
const target = process.argv[2] || '3006';
const base = `http://${target.includes(':') ? target : `127.0.0.1:${target}`}`;
const plugins = ['redmine_gantrix', 'redmine_issue_trash', 'redmine_issue_templates', 'redmine_microsoftteams',
                 'redmine_merge_request_links', 'redmine_textile_transparent'];
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  await page.goto(`${base}/login`);
  await page.fill('#username', 'admin');
  await page.fill('#password', 'admin');
  await Promise.all([page.waitForNavigation(), page.click('#login-submit')]);
  const open = async (path) => (await page.goto(`${base}${path}`)).status();

  await open('/admin/plugins');
  const listed = await page.evaluate((ids) => ids.filter((id) => !document.getElementById(`plugin-${id}`)), plugins);
  check('all recommended plugins are installed', listed.length === 0, listed.length ? `missing: ${listed.join(', ')}` : '');

  // the plugin settings pages
  for (const id of ['redmine_issue_templates', 'redmine_microsoftteams']) {
    check(`${id} settings open`, (await open(`/settings/plugin/${id}`)) === 200);
  }

  // redmine_textile_transparent: the Hybrid text format can be chosen
  await open('/settings?tab=general');
  check('the Hybrid text format is offered', await page.locator('#settings_text_formatting option[value="hybrid"]').count() === 1);

  // redmine_issue_templates: global templates, and the template picker on a new issue
  check('global issue templates open', (await open('/global_issue_templates')) === 200);
  await open('/projects/demo/issues/new');
  check('the new issue form has the template picker', await page.locator('#issue_template').count() === 1);

  // redmine_merge_request_links: its stylesheet is on the issue page, which still opens
  const issue = await page.evaluate(async () => (await (await fetch('/projects/demo/issues.json?limit=1')).json()).issues[0].id);
  check('an issue opens', (await open(`/issues/${issue}`)) === 200);
  check('merge request links are loaded on the issue page',
        await page.locator('link[href*="redmine_merge_request_links"]').count() > 0);

  // the Gantrix screens still open with all plugins installed
  for (const path of ['/projects/demo/gantrix', '/projects/demo/gantrix/dashboard', '/projects/demo/gantrix/kanban',
                      '/projects/demo/gantrix/report', '/gantrix/portfolio']) {
    check(`${path} opens`, (await open(path)) === 200);
  }
  await page.waitForSelector('.gx-pf-table');

  check('no JavaScript errors', errors.length === 0, errors.join(' / '));
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PLUGIN TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
