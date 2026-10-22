# Security policy

Pi >=1.3.0 <1.5.0 on Linux with Node 22.19+ is supported (1.4.0 is the tested baseline). Security fixes will
be released as updates become available.

Report vulnerabilities privately through GitHub's Security → Report a vulnerability
form. If private reporting is unavailable, contact the repository owner through
their GitHub profile before opening a public issue.
Do not attach real session histories, API keys, authentication files, or private
host logs to public issues. Include a minimal reproduction using temporary state.

The extension runs with your user permissions. It is not a sandbox. Managed
sessions share a host process, and third-party extensions can share module state.
Install trusted Pi packages and follow Pi's project trust controls. A process
running as the same OS user can access host state and control its local socket.

See [the security review](docs/SECURITY-REVIEW.md) for protections and limitations.
