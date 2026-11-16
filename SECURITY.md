# Security policy

Report suspected vulnerabilities privately using
[GitHub private vulnerability reporting](https://github.com/curlewlabs-com/worker-lazy/security/advisories/new).
Include the affected release or source revision, the runtime and its version,
a minimal Worker or source file that shows the problem, and what you observed
against what you expected.

A path on which a failed deferred load reaches handler code or returns a
catchable rejection instead of ending the isolate is a vulnerability, as is one
on which concurrent cold callers end up sharing a promise. So is a lint rule
that passes a static value import or a dynamic `import()` its README says it
rejects. The limits the README states under "Limits" are the design, not
vulnerabilities, though reports that one of them is wrongly described are
welcome.

Curlew Labs maintains this repository; Jeffrey Wall
([jeffwall-curlewlabs](https://github.com/jeffwall-curlewlabs)) is the release
and security contact through GitHub. Reports are reviewed on a best-effort basis
without a guaranteed response time. Fixes target the latest release; older
releases have no promised backport.
