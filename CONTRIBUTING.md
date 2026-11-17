# Contributing

Thanks for your interest in improving `worker-lazy`. The bar for a change is
whether a deferred module still costs nothing once it is loaded, and a load
that fails still ends the isolate instead of degrading quietly. Bug fixes, a
rule that closes a gap the README's "Limits" names, and clearer docs are all
welcome.

## Before a large change

Open an issue describing the problem first. `src/lazy.ts` carries the two
safety invariants: the cold path caches the loaded module and never the
in-flight promise, so no request awaits a promise another request created, and
a failed load logs one line and ends the isolate rather than handing back a
rejection. A short discussion up front saves rework.

## Releasing

A patch or minor release needs no approval: whoever cuts it follows the steps
below in order, on a `main` commit whose required checks have passed. A major
version, a 1.0, or a minor before 1.0 that changes an interface consumers use
needs the maintainer's explicit approval before its tag is pushed.

A release is a fixed `vMAJOR.MINOR.PATCH` tag and the GitHub Release published
on it, carrying the `npm pack` tarball that consumers install by URL. The
package is not published to the npm registry. The fixed-version-tag ruleset and
release immutability lock the tag and its asset once the release is published,
so a mistake in a published release is fixed by the next release, never by
editing this one.

Release when `main` changes what the tarball ships, `src/` or `eslint/`, since
the last tag. A fix is a patch release. Until 1.0, a minor release is any
change that can break a consumer's build: a rule that now reports code it used
to pass, or a changed export or exported type.

1. In a pull request, set the version and the README's install URL. The URL
   names the tarball, and the tarball's name carries the version:

   ```sh
   npm version 0.2.1 --no-git-tag-version
   ```

   That updates `package.json` and `package-lock.json`. Then edit the
   `npm install` line in the README by hand.

2. Once it is merged, wait for the `CI` run on that `main` commit to pass
   (its `conclusion` job), and the CodeQL `Analyze` jobs too, then tag that commit and push the
   tag:

   ```sh
   git tag v0.2.1 <commit>
   git push origin v0.2.1
   ```

3. The tag starts `release.yml`. It refuses a commit that is not on `main` or
   a tag that does not match `package.json`'s version. It then runs CI again
   on the tagged commit, packs the tarball, attests its build provenance, and
   creates a draft release. The draft carries the tarball and notes giving the
   install command and the tarball's SHA-512 integrity.

4. Check the draft against a local build of the tagged commit. The two
   integrity values must be equal:

   ```sh
   git checkout v0.2.1
   npm ci --ignore-scripts
   mkdir /tmp/check
   npm pack --pack-destination /tmp/check
   echo "sha512-$(openssl dgst -sha512 -binary /tmp/check/*.tgz | openssl base64 -A)"
   gh release view v0.2.1 --json body -q .body
   ```

5. Add the release notes below the draft's install block and integrity line.
   Say that the package is not on the npm registry, then what changed, by
   issue. Give its own section to anything that now fails lint that passed
   before, and to any change to an exported type or to runtime behavior. Then
   publish:

   ```sh
   gh release edit v0.2.1 --notes-file notes.md --draft=false --latest
   ```
