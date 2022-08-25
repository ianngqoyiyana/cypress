export function launchStudio () {
  cy.scaffoldProject('experimental-studio')
  cy.openProject('experimental-studio')
  cy.startAppServer('e2e')
  cy.visitApp()
  cy.visit(`http://localhost:4455/__/#/specs/runner?file=cypress/e2e/spec.cy.js`)

  cy.waitForSpecToFinish()

  // Should not show "Studio Commands" until we've started a new Studio session.
  cy.get('[data-cy="hook-name-studio commands"]').should('not.exist')

  cy
  .contains('visits a basic html page')
  .closest('.runnable-wrapper')
  .realHover()
  .findByTestId('launch-studio')
  .click()

  // Studio re-executes spec before waiting for commands - wait for the spec to finish executing.
  cy.waitForSpecToFinish()

  cy.get('[data-cy="hook-name-studio commands"]').should('exist')
}
