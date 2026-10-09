# DSH 0.2 compatibility

This release requires DSH 0.2.1-alpha.1 or a compatible 0.2 release. The verified upstream revision is 5badb15009ae1756c3afe0ae0cef1faafc290ccc.

Declared DSH dependencies and browser injection packages match the current package inventory. Removed runtime and invariant packages are no longer declared.

Install the fixed commit reachable from the repository main branch through dsh plugin. The shared environment stores full commit ids; local source paths are not portable plugin pins.

The maintenance lockfile disables implicit peer installation and uses the current Cordis and schemastery versions. Git packages build without depending on the source checkout node_modules.

Plan indicators use the public root-scoped sidebar.session.row.leading and sidebar.session.row.hover slots. Remove older local session.badges and session.title patches when upgrading. Titles and search results follow the host; full plan state appears in each row hover card, while host activity indicators take precedence over the idle-row marker.
