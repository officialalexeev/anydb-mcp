<!--
  Two commands before you open the pull request. Both, not one:

    npm test
    npm run verify:package

  The second one is not a repeat of the first. The unit suite runs against the
  working tree, where this repository's own `.npmrc` allow-scripts applies, so it
  cannot see anything that only breaks once the package is installed somewhere
  else. That gap shipped 2.0.0: every test passed and every consumer whose npm
  blocked the sqlite3 install script got a server that died on startup. If you
  touch `files`, `exports`, `bin`, or any dependency, this is the check that
  notices.
-->

## What this changes

<!-- One paragraph. What a reader needs to know before reading the diff. -->

## Why

<!-- The problem, not the solution. "Because the alternative was worse" is a why. -->

## Checklist

- [ ] `npm test` passes.
- [ ] `npm run verify:package` passes, if anything in `package.json`, `files`, `exports`, `bin` or the dependency list changed. If you cannot run it, say so in the description rather than leaving it ticked.
- [ ] `CHANGELOG.md` has an entry, or the pull request says why it does not need one. Every user-visible change needs one; a test-only or CI-only change does not. The changelog is the first thing somebody reads when they ask "why did this stop working", so it is written for that reader, not for the diff.
- [ ] The new code has a test that fails without it. A test that passes before and after the change is not a test of the change.
- [ ] No credential, connection string, or `db.json` content is in the diff, and no test fixture contains a real host.
- [ ] Commit messages follow Conventional Commits, which is what the log already uses:

  ```
  fix: <what was wrong>
  feat!: <what is new, and what breaks>
  feat: <what is new>
  test: <what is now covered>
  docs: <what changed in the documentation>
  chore: <dependency bumps, formatting, CI>
  ```

  A `!` after the type, or a `BREAKING CHANGE:` paragraph in the body, marks a
  breaking release. `feat!:` is right for a change that makes an existing call
  fail or an existing answer different; a behaviour nobody could have been
  relying on is not breaking, and marking it as such makes the next major bump
  meaningless.

## Notes for the reviewer

<!--
  Worth knowing before reading:
  - why this approach over the obvious one,
  - what you deliberately did not do,
  - anything you are unsure about. Saying "I am not sure about the Mongo path"
  is more useful than a confident wrong line.
-->

## Out of scope

<!--
  Deliberately not done here, so it is not mistaken for an oversight. An issue
  number is better than a paragraph in a diff nobody reads in six months.
-->
