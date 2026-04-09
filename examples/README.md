# Example Flows

Importable `.flow.json` files showcasing TwistedRest's capabilities. To use one:

1. Open TwistedRest
2. Select a project in the sidebar
3. Click **+ import** (below the flow list)
4. Pick a `.flow.json` file

## Available Examples

### [jsonplaceholder-demo.flow.json](./jsonplaceholder-demo.flow.json)

**The kitchen sink.** Exercises 11 of 14 node types against the free JSONPlaceholder API:

- Fetch a user → Break Object → Make Object (assemble summary)
- Break nested company object
- Convert id (number → string) → fetch user's posts
- Match on HTTP status (200 → iterate posts, 404 → error)
- ForEach Sequential → log each post title
- Emit Event "userProcessed" with payload → On Event listener logs in parallel
- Tap node shows all 10 post values

**Setup:** No env needed — uses absolute URLs.

### [github-user-repos.flow.json](./github-user-repos.flow.json)

**Real-world GitHub API workflow.** Fetches a user's profile + top 5 repos:

- EnvVar for username → Convert → HTTP Request (user profile)
- Make Object with name/repos/followers → Log "User info"
- Fetch repos sorted by stars → ForEach → Break Object → Log each repo

**Setup:** Create an env with variable `username` = any GitHub username (e.g. `torvalds`).

### [weather-with-error-handling.flow.json](./weather-with-error-handling.flow.json)

**Error handling + Function node.** Fetches weather data with graceful error routing:

- EnvVar for city → HTTP Request to wttr.in
- Match on status code: 200 → process weather data, default → log error
- Function node formats the raw weather array into a human-readable summary string
- Demonstrates the Function node's TypeScript transform capability

**Setup:** Create an env with variable `city` = any city name (e.g. `London`).

## Contributing Examples

See [CONTRIBUTING.md](../CONTRIBUTING.md#contributing-example-flows) for guidelines on creating and submitting example flows.
