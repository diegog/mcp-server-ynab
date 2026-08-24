# mcp-server-ynab

An [MCP](https://modelcontextprotocol.io) server wrapping the
[YNAB](https://www.ynab.com) API, so an MCP client can read and modify a budget
through tool calls. Runs as a local process over stdio — your Personal Access
Token stays in your own environment.

> **Status: early.** The toolchain is scaffolded; tools are still being built.
> Full usage docs land with the first release (ENG-36).

## Development

Requires Node 26+, which runs TypeScript directly.

```bash
npm install
node src/index.ts     # start the server on stdio
npm run check         # lint + typecheck
```

See [AGENTS.md](AGENTS.md) for architecture, conventions, and the constraints
that shape this codebase.

## License

MIT © Diego Garcia
