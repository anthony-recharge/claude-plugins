# premise-check

Claude's knowledge of libraries and frameworks comes from its training data, and new releases often add the very feature it says is missing. For example, Claude might say that a library has no integration with a platform, or might build a workaround for a missing feature, when a newer release already supports it. With this plugin, a cheap side agent (Haiku by default) watches the session for claims like that and gets them checked. It works the same way as Claude Code's built-in "You should know" watcher.

## Install

```
/plugin install premise-check --marketplace anthony-recharge/claude-plugins
```

See the [repository README](../../README.md) for other ways to install.

## How it works

1. **Watcher.** During a long turn the watcher checks in every few model requests (6 by default), and it always checks at the end of a turn. Each check sends Haiku the newest part of the conversation: the user's prompt, what Claude said, and the commands and code Claude wrote. Haiku also gets a list of lookups Claude has already made and the claims it already flagged. Haiku answers with JSON listing up to 3 claims that rest on unverified training-data knowledge:
   - `unsupported`: "X doesn't support Y", "there's no integration", "deprecated"
   - `version`: "the latest version is …", "v4 added …"
   - `workaround`: building a shim or custom adapter because a feature is assumed to be missing
   - `api`: code that depends on API details likely to have changed (flagged sparingly)

   Any claim Claude already checked against a live source is skipped. Live sources are web search or fetch, a docs MCP like Context7, registry commands (`npm view`, `dotnet package search`, `pip index`, `gh release`, registry `curl`s …), or reading an installed package's source.
2. **Banner.** A flagged claim shows up above the prompt with **1 Ask Claude to check**, **2 Verify independently** and **0 Dismiss**, and the banner reports how the check went.
3. **Automatic action.** Set it with `/premise-check <action>` or in `/config`:

| Action | What happens on a flag |
| --- | --- |
| `nudge` (default) | Tells Claude to verify the claim. If a turn is running, the note goes into that turn; otherwise it starts a new turn. |
| `verify` | A background checker subagent with web access checks registries, release notes and docs, plus the version your project pins. Claude only hears about it if a claim turns out to be outdated. |
| `ask` | Shows the banner and does nothing else until you choose. |
| `off` | Watches nothing. |

4. **System prompt rule.** Claude is told to check before saying something is unsupported, naming the latest version, or building a workaround.

## Commands

- `/premise-check now`: have the watcher review the recent conversation now
- `/premise-check nudge|verify|ask|off`: choose the action (saved across sessions)
- `/premise-check status`: show the current settings

You can also change the watcher model, the checker model and how many steps pass between checks in `/config`.

## Examples

These prompts come from a live test of version 0.2.1 on 2026-10-15. The action was `verify`, and the watcher and the checker used Haiku. The test used a new, empty directory. Each prompt asks about a release that is newer than the training data of the model, or tells the agent not to use tools. This makes the agent answer from memory.

| Prompt | What the agent said | What the plugin did |
| --- | --- | --- |
| "Answer from memory in one or two sentences, do not look anything up or use any tools: what is the latest stable version of Next.js, and does C# have discriminated union types yet?" | Next.js 16.x, and C# unions are in preview for C# 15 / .NET 11. The agent said that the answer came from memory and could be out of date. | The watcher flagged no claim. |
| "Don't use any tools. In a short code block, write the C# for a Shape type that can be a Circle or a Square, using the OneOf NuGet package since C# itself has no union types." | A `OneOfBase<Circle, Square>` class, and a note that `[GenerateOneOf]` from `OneOf.SourceGenerator` writes the constructor and the conversion operators. | The watcher flagged the `OneOf.SourceGenerator` claim. It did not flag "C# has no union types", because the user said that. The checker found the claim correct (CONFIRMED). The agent got no message. |
| "No tools and no hedging, one plain sentence: which Next.js version is the latest stable release?" | "As of my training data, the latest stable release of Next.js is version 16." | The watcher flagged the version claim. The checker found that 16 is still the current major version (CONFIRMED). The agent got no message. |
| "No tools and no hedging, one plain sentence: what is the exact latest Next.js version number, major.minor.patch?" | The agent did not give a number, because it could not know the minor and patch versions. | The watcher flagged no claim. |
| "No tools. Show me the minimal csproj for a net11.0 console app that uses runtime-native async, with every property it needs, and say in one sentence why each property is there." | A csproj with `<EnablePreviewFeatures>true</EnablePreviewFeatures>` and `<Features>$(Features);runtime-async=on</Features>`, with a note that the feature changes between previews. | The watcher flagged three claims about the csproj properties. The checker found one claim OUTDATED: a `net11.0` project does not need `EnablePreviewFeatures` for runtime async. The plugin sent the report to the agent one time. The agent removed the property, and told the user what changed and why. |

The checker ran for three of the prompts. Each time, the plugin dropped the engine's own copy of the checker report (the "hand-back"). The agent got only the plugin message, and only for the OUTDATED verdict.

## Cost and limits

- Each check is one Haiku call. The fixed instructions are cached, and the rest is at most about 12k characters of new conversation. The watcher skips the call when Claude hasn't said or written anything new.
- Haiku's training data is stale too, so it only spots claims and never judges whether they're true. The checker subagent or Claude itself does the actual checking.
- The watcher can miss claims or flag ones that didn't need checking. It never flags the same claim twice in a session.
- If your organization manages Claude Code, the system prompt rule doesn't run for a plugin you installed yourself. The watcher still runs.

## Develop

```
claude plugin validate plugins/premise-check
claude plugin test plugins/premise-check
claude --plugin-dir ./plugins/premise-check
```
