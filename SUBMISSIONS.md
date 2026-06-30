# Distribution checklist — gate402-mcp

The MCP server is *distribution* for the existing Gate402 endpoints. Ship it to where
agents-with-users actually live (Claude Desktop, Cursor, Cline) via these channels, in order.

## 0. Prereqs (one-time)
- [ ] Create public GitHub repo `pgalyen1987/gate402-mcp` and push this directory.
- [ ] `npm publish` (package name `gate402-mcp`, MIT). Verify `npx -y gate402-mcp` runs.
- [ ] Confirm `npx -y gate402-mcp` lists 4 tools (handshake tested locally ✓).

## 1. Official MCP Registry  (registry.modelcontextprotocol.io)
The canonical index; many clients pull from it. Publish with the official CLI:
```bash
# install the publisher
brew install mcp-publisher    # or: download from github.com/modelcontextprotocol/registry releases
mcp-publisher login github    # auth as pgalyen1987 (must own the io.github.pgalyen1987/* namespace)
mcp-publisher publish          # reads ./server.json
```
- [ ] `server.json` name uses the `io.github.pgalyen1987/*` namespace (matches the GitHub owner — required for auth).
- [ ] Published; appears at registry.modelcontextprotocol.io.

## 2. awesome-mcp-servers  (punkpeye/awesome-mcp-servers — the high-traffic list)
Open a PR adding this line under a fitting category (🔎 **Search & Web** / 🌐 **Browser Automation**),
keeping the repo's alphabetical + emoji-legend conventions:

```markdown
- [pgalyen1987/gate402-mcp](https://github.com/pgalyen1987/gate402-mcp) 📇 ☁️ - Pay-per-call agent APIs over x402: web→Markdown scraping, stealth fetch, token compression, and semantic cache. Free tier, no signup.
```
(Legend: 📇 = TypeScript, ☁️ = cloud service. Check the current legend before submitting — it shifts.)
- [ ] PR opened. Also consider the secondary list `appcypher/awesome-mcp-servers`.

## 3. modelcontextprotocol/servers  (#community-servers section)
Add the same one-liner to the community servers table in the canonical servers repo README.
- [ ] PR opened.

## 4. Client-specific surfaces
- [ ] Cursor "Add to Cursor" / MCP directory submission.
- [ ] Glama.ai and mcp.so directories (auto-crawl GitHub topic `mcp`; add the `mcp` + `model-context-protocol` topics to the repo to get picked up).
- [ ] Smithery.ai listing (hosts a config UI; good install funnel).

## 5. Cross-link with existing distribution
- [ ] Add the MCP server to the awesome-x402 PR (#660) description / Gate402 entry — x402 buyers will want the MCP path too.
- [ ] Link it from gate402.app landing page (done) and from each upstream repo README (NodeProxy / TokenSqueezer / VectorCache).

> The win condition is the same as LAUNCH.md: **one real integrator doing volume.** These listings
> are top-of-funnel; the OUTREACH kit (../OUTREACH.md) is the direct path to that first integrator.
