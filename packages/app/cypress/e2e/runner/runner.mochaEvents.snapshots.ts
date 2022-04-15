export const snapshots = {
  'fail-with-before.mochaEvents.cy.js': [
    'start',
    'suite',
    'suite',
    'hook',
    'test:before:run',
    'fail',
    'suite end',
    'test end',
    'test:after:run',
    'suite end',
    'end',
  ],

  'fail-with-beforeEach.mochaEvents.cy.js': [
    'start',
    'suite',
    'suite',
    'test',
    'hook',
    'test:before:run',
    'fail',
    'test end',
    'suite end',
    'test:after:run',
    'suite end',
    'end',
  ],

  'fail-with-after.mochaEvents.cy.js': [
    'start',
    'suite',
    'suite',
    'test',
    'test:before:run',
    'pass',
    'test end',
    'test:after:run',
    'test',
    'test:before:run',
    'hook',
    'fail',
    'test end',
    'suite end',
    'test:after:run',
    'suite end',
    'end',
  ],

  'fail-with-afterEach.mochaEvents.cy.js': [
    'start',
    'suite',
    'suite',
    'test',
    'test:before:run',
    'hook',
    'fail',
    'test end',
    'suite end',
    'test:after:run',
    'suite end',
    'end',
  ],

  'fail-with-only.mochaEvents.cy.js': [
    'start',
    'suite',
    'suite',
    'hook',
    'test:before:run',
    'hook end',
    'test',
    'hook',
    'hook end',
    'fail',
    'hook',
    'hook end',
    'hook',
    'hook end',
    'test end',
    'suite end',
    'test:after:run',
    'suite end',
    'end',
  ],

  'pass-with-only.mochaEvents.cy.js': [
    'start',
    'suite',
    'suite',
    'hook',
    'test:before:run',
    'hook end',
    'test',
    'hook',
    'hook end',
    'hook',
    'hook end',
    'hook',
    'hook end',
    'pass',
    'test end',
    'suite end',
    'test:after:run',
    'suite end',
    'end',
  ],
} as const