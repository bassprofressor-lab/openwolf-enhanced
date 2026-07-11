<p align="center">
  <img src="../../openwolf-icon.png" alt="OpenWolf Enhanced" width="120" />
</p>

<h1 align="center">OpenWolf Enhanced</h1>

<p align="center">
  <strong>Ein zweites Gehirn für Claude Code — begrenzt, selbstwartend und jetzt auch aus Claude Desktop erreichbar.</strong><br />
  Projekt-Intelligenz, Token-Tracking und unsichtbare Durchsetzung über 7 Hook-Skripte — plus ein read-only MCP-Server, der dein Wissen mit nach Claude Desktop und jeden MCP-Client nimmt. Null Workflow-Änderungen.
</p>

<p align="center">
  🌐 <a href="../../README.md">English</a> · <strong>Deutsch</strong>
</p>

---

> **Dies ist ein erweiterter Fork von [OpenWolf](https://github.com/cytostack/openwolf)** von Cytostack Pvt Ltd.
> Das Original ist eine großartige Idee; in langlebigen Projekten konnte sein `.wolf/`-Verzeichnis jedoch
> unbegrenzt wachsen (mehrere Megabyte große Token-Ledger, ein ständig wachsendes Bug-Log, vollständige
> Datei-Rewrites bei jeder Änderung). Dieser Fork behält alles, was das Original tut, und macht den Speicher
> **begrenzt, selbstwartend und einschränkbar**. Der CLI-Befehl ist weiterhin `openwolf`, also ein
> Drop-in-Ersatz. Siehe [Was ist verbessert](#was-ist-verbessert) und das [CHANGELOG](../../CHANGELOG.md).

**Funktioniert mit [Claude Code](https://claude.com/claude-code), [OpenAI Codex CLI](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli) und [OpenCode](https://github.com/sst/opencode)** — plus Claude Desktop und jedem MCP-Client. Persistentes Projekt-Gedächtnis, zitierbare Suche und Kontext-Injektion über unsichtbare Hooks. Git-nativ, ohne Datenbank, ohne Cloud.

**Inhalt:** [Warum](#warum-openwolf-existiert) · [Was ist verbessert](#was-ist-verbessert) · [Schnellstart](#schnellstart) · [Befehle](#befehle) · [Claude Desktop / MCP](#nutzung-in-claude-desktop-mcp) · [FAQ](#faq)

## Warum OpenWolf existiert

Claude Code ist mächtig, arbeitet aber blind. Es weiß nicht, was eine Datei enthält, bis es sie öffnet. Es kann eine 50-Token-Config nicht von einem 2.000-Token-Modul unterscheiden. Es liest dieselbe Datei mehrmals in einer Session, ohne es zu merken. Es hat keinen Index deines Projekts, keine Erinnerung an deine Korrekturen und kein Bewusstsein dafür, was es bereits versucht hat.

OpenWolf gibt Claude ein zweites Gehirn: einen Datei-Index, damit es vor dem Lesen weiß, was Dateien enthalten, ein lernendes Gedächtnis, das deine Präferenzen und vergangene Fehler sammelt, und ein Token-Ledger, das alles verfolgt. Alles über 7 unsichtbare Hook-Skripte, die bei jeder Claude-Aktion feuern.

## Was ist verbessert

Alles, was Upstream tut, plus — gruppiert nach dem, was es dir bringt:

| Bereich | Verbesserung |
|---------|--------------|
| 🩺 **Selbstwartung** | `openwolf doctor` meldet den `.wolf/`-Footprint und kompaktiert alles (Ledger, Memory, Bug-Log, Backups, Logs, tmp), erkennt projektübergreifende Registry-Probleme, schlägt `.wolfignore`-Einträge für rauschende Verzeichnisse vor und weist auf near-duplicate cerebrum-Einträge hin — und `openwolf consolidate` führt sie per LLM zusammen. `--dry-run` zeigt eine Vorschau. |
| 📦 **Begrenzter, einstellbarer Speicher** | Ledger, Bug-Log, Cron-Queues und Waste-Flags sind alle gedeckelt — keine ausufernden Multi-MB-Dateien. Jedes Limit steht in `openwolf.retention` und übersteht Updates (Config wird tief gemerged, nicht überschrieben). |
| 🧭 **Intelligenter Session-Resume** | Beim Session-Start wird ein kompakter, token-begrenzter Digest injiziert — STATUS + Do-Not-Repeat inline, jüngste Aktivität als Ein-Zeilen-Headline, der Rest als *„Available on demand"*-Index — damit das Modell weiterarbeitet, ohne neu zu lesen. |
| 📓 **Passives Activity-Capture** *(opt-in)* | Datei-Edits werden immer journaled; mit aktiviertem `openwolf.capture` hängt ein `PostToolUse:Bash`-Hook zusätzlich nennenswerte Kommandos (Commits, Installs, Tests, Builds, Deploys) **und Fehler** an ein größen-gecapptes `.wolf/activity.log`, das in den Resume-Digest der nächsten Session einfließt. Secrets werden redigiert, triviale Read-only-Kommandos verworfen. Standardmäßig aus. |
| 🔎 **Durchsuchbares Gedächtnis + Zitate** | `openwolf recall <query>` durchsucht STATUS / cerebrum / memory / buglog **und Claudes native Auto Memory** per Keyword, **BM25-gerankt** (seltene Terme höher gewichtet, längen-normalisiert), und liefert einen kompakten Index, in dem jeder Treffer eine stabile Zitat-ID wie `[c-3f9a]` trägt. Einen Eintrag mit `recall --id <id>` (oder alle inline mit `--full`) expandieren — Progressive Disclosure, ohne Datenbank. IDs in Notizen zitieren, um sie später wieder zu öffnen; `recall --all` durchsucht alle registrierten Projekte. |
| 🧠 **Native-Memory-Interop** | Liest Claude Codes eigene Auto Memory (read-only): `doctor` deckt deren Blindstellen auf (Dateien, die der `MEMORY.md`-Index nie lädt, die 200-Zeilen-Grenze, tote Links), ein Dashboard-Panel durchstöbert sie, und ein **MCP-Server** (`openwolf mcp`) stellt recall/resume für **Claude Desktop** und andere MCP-Clients bereit — so wirkt OpenWolf über Claude Code hinaus. |
| 🐝 **Über Claude Code hinaus** | `init`/`update` erkennen **Codex CLI**, **Gemini CLI** und **OpenCode** automatisch und registrieren OpenWolfs Hooks auch dort. Codex & Gemini teilen Claudes Hook-Modell → Session-Start-Resume-Digest wird injiziert + Aktivität erfasst; OpenCode bekommt einen JS-Plugin-Adapter (Injektion zur Compaction-Zeit). Claude bleibt primäres, unverändertes Ziel. |
| 🔌 **Modell-agnostische AI-Tasks** | Die AI-Tasks des Hintergrund-Cron-Engines nutzen standardmäßig die Anthropic-API, lassen sich aber über `openwolf.cron`-Config auf **jeden OpenAI-kompatiblen Endpoint** richten (OpenAI, Groq, Cerebras, Mistral, Qwen, lokaler Server) — `llm_provider` / `llm_base_url` / `llm_model` / `api_key_env`. Kein Code-Change; bestehende Setups laufen unverändert auf Claude. |
| 🌍 **Lokalisierter Digest** | Der injizierte Session-Start-Resume-Digest kann auf Deutsch rendern — `openwolf.lang` oder `OPENWOLF_LANG` setzen. Standard ist Englisch. |
| 🔒 **Datenschutz** | `<private>…</private>`-Inhalt in einer beliebigen `.wolf`-Datei bleibt aus dem injizierten Kontext und aus der Suche heraus. |
| 🗒 **Strukturierte Summaries** | Jede Session bekommt ein `Did / Learned / Next / Files`-Gerüst — konsistentes, grep-bares Gedächtnis. |
| 📤 **Export** | `openwolf export <sessions\|bugs>` als JSON oder CSV (RFC 4180). |
| 🎯 **`.wolfignore`** | gitignore-artiges Scoping fürs Anatomy-Scanning **und** Hook-Tracking; `doctor` schlägt vor, was hinein soll. |
| 📊 **Dashboard** | Deep-linkbare Panels, eine projektübergreifende **All-Projects**-Ansicht, ein **Command Log** für das opt-in Bash-Capture, Jump-to-file aus den AI-Insights, ein Design-QC-Thumbnail-Grid + Lightbox und ein Daemon-down-Banner. |
| 🔒 **Sicherheit & Korrektheit** | Dashboard an Loopback gebunden und token-geschützt, keine Command-Injection / kein Path-Traversal, Ausschluss von Secret-Dateien (`.pem`/`.key`/`id_rsa`…), plus ~15 übernommene Upstream-Security- und Bugfixes, die der inaktive Upstream nie gemerged hat. |
| 🚀 **Vertrauenswürdige Releases** | Via GitHub OIDC auf npm veröffentlicht — kein langlebiges Token — mit SLSA-Provenance; CI baut und testet bei jedem Push. |

Jede Änderung ist im [CHANGELOG](../../CHANGELOG.md) versioniert; die Attribution steht im [NOTICE](../../NOTICE).

## Schnellstart

```bash
npm install -g openwolf-enhanced
```

> **Hinweis:** Dies ist der gepflegte Fork. `npm install -g openwolf` installiert das originale
> `openwolf` (zuletzt 1.0.4, März 2026, ungepflegt) — ein anderes Paket. Installiere
> `openwolf-enhanced` für den begrenzten Speicher, die Selbstwartung und die Security-Arbeit.
> Beide stellen denselben `openwolf`-Befehl bereit.

<details>
<summary>Stattdessen aus dem Quellcode installieren</summary>

```bash
git clone https://github.com/bassprofressor-lab/openwolf-enhanced.git
cd openwolf-enhanced
pnpm install
pnpm build            # baut CLI, Hooks und Dashboard
npm install -g .      # installiert den `openwolf`-Befehl global
```
</details>

Dann in einem beliebigen Projekt:

```bash
cd dein-projekt
openwolf init
```

Das war's. Nutze `claude` wie gewohnt. OpenWolf beobachtet.

## Was es erstellt

`openwolf init` erstellt ein `.wolf/`-Verzeichnis in deinem Projekt:

| Datei | Zweck |
|-------|-------|
| `STATUS.md` | Single-Source-of-Truth-Handoff — aktuelle Quest, nächste Schritte, Gotchas; beim Resume zuerst lesen |
| `anatomy.md` | Projekt-Dateikarte mit Beschreibungen und Token-Schätzungen |
| `cerebrum.md` | Gelernte Präferenzen, Korrekturen, Do-Not-Repeat-Liste |
| `memory.md` | Chronologisches Aktions-Log mit Token-Schätzungen |
| `buglog.json` | Bugfix-Gedächtnis, durchsuchbar, verhindert Wiederentdeckung |
| `token-ledger.json` | Lebenslanges Token-Tracking und Session-Historie |
| `hooks/` | 7 Claude-Code-Lifecycle-Hooks (reines Node.js) |
| `config.json` | Konfiguration mit sinnvollen Defaults (inkl. `retention`) |
| `identity.md` | Agenten-Persona für dieses Projekt |
| `OPENWOLF.md` | Anweisungen, denen Claude jede Session folgt |

## Wie es funktioniert

Bevor Claude eine Datei liest, sagt OpenWolf ihm, was sie enthält und wie groß sie ist. Wenn Claude die Datei in dieser Session bereits gelesen hat, warnt OpenWolf. Bevor Claude Code schreibt, prüft OpenWolf dein `cerebrum.md` auf bekannte Fehler. Nach jedem Schreiben aktualisiert es die Projektkarte und protokolliert den Token-Verbrauch. Du siehst nichts davon. Es passiert einfach.

```
Du tippst eine Nachricht
    ↓
Claude entscheidet, eine Datei zu lesen
    ↓
OpenWolf: „anatomy.md sagt, diese Datei hat ~380 Tokens. Beschreibung: Haupt-Einstiegspunkt."
    ↓
Claude liest die Datei → OpenWolf protokolliert den Read, prüft auf wiederholte Reads
    ↓
Claude schreibt Code → OpenWolf prüft cerebrum.md auf bekannte Fehler
    ↓
Claude ist fertig → OpenWolf aktualisiert anatomy.md, ergänzt memory.md, aktualisiert das Ledger
```

## `.wolf/` gesund halten

Das `.wolf/`-Verzeichnis ist darauf ausgelegt, klein zu bleiben, aber bei sehr aktiven Projekten kannst du es jederzeit kompaktieren — kein Daemon nötig:

```bash
openwolf doctor --dry-run   # Footprint + Warnungen melden, nichts ändern
openwolf doctor             # Ledger kompaktieren, Memory konsolidieren, Buglog dedupen,
                            # Backups prunen, Logs rotieren, tmp leeren
```

`openwolf status` zeigt den aktuellen Footprint und warnt, bevor etwas groß wird.

### Limits einstellen

Bearbeite den `openwolf.retention`-Block in `.wolf/config.json` (Defaults gezeigt):

```json
{
  "openwolf": {
    "retention": {
      "token_ledger_max_sessions": 200,
      "session_io_max": 100,
      "buglog_max_entries": 200,
      "backups_keep": 10,
      "memory_consolidate_after_days": 7,
      "memory_max_bytes": 262144,
      "daemon_log_max_bytes": 524288
    }
  }
}
```

Diese überstehen `openwolf update` (Config wird tief gemerged, nicht überschrieben).

### Scoping mit `.wolfignore`

Lege ein `.wolfignore` im Projekt-Root an, um Pfade vom Anatomy-Scanning und Hook-Tracking auszuschließen (gitignore-Stil):

```
vendor/
dist/
**/*.generated.ts
*.log
```

## Befehle

```
openwolf init                 .wolf/ initialisieren und Hooks registrieren
openwolf status               Health, Stats, .wolf/-Footprint, Größen-Warnungen anzeigen
openwolf doctor               .wolf/ melden + kompaktieren, .wolfignore vorschlagen [--dry-run]
openwolf consolidate          Near-duplicate cerebrum-Eintraege per LLM zusammenfuehren [--dry-run] [--threshold N]
openwolf recall <query>       .wolf + native Memory suchen; ID je Treffer [--limit N] [--full] [--all] [--json]
openwolf recall --id <id>     Zitat-ID zum vollen Eintrag expandieren (zweite Disclosure-Ebene)
openwolf export <what>        sessions|bugs als JSON oder CSV exportieren [--format csv] [--out FILE]
openwolf mcp                  MCP-Server (recall/resume/memory-health) starten [--project DIR]
openwolf scan                 Projekt-Strukturkarte aktualisieren [--check]
openwolf dashboard            Das Echtzeit-Web-Dashboard öffnen
openwolf daemon <cmd>         start | stop | restart | logs — Hintergrund-Scheduler
openwolf cron <cmd>           list | run <id> | retry <id> — geplante Tasks
openwolf designqc             Full-Page-Screenshots zur Design-Bewertung erstellen
openwolf bug search <term>    Bug-Gedächtnis nach bekannten Fixes durchsuchen
openwolf update               Registrierte Projekte aktualisieren [--project NAME] [--dry-run] [--list]
openwolf restore [backup]     .wolf/ aus einem zeitgestempelten Backup wiederherstellen
```

## Design QC

Erstelle Full-Page-Screenshots deiner laufenden App und lass Claude das Design bewerten.

```bash
openwolf designqc
```

Erkennt deinen Dev-Server automatisch, erfasst viewport-hohe JPEG-Abschnitte jeder Route und speichert sie in `.wolf/designqc-captures/`. Dann sagst du Claude, es soll die Screenshots lesen und bewerten. Benötigt `puppeteer-core`.

## Nutzung in Claude Desktop (MCP)

OpenWolfs Such- und Resume-Werkzeuge laufen auch als **MCP-Server** — funktionieren also in der
Claude-Desktop-App und jedem MCP-Client, nicht nur in Claude Code.

**Ein-Klick-Installation (Desktop Extension).** Lade `openwolf.mcpb` aus dem
[neuesten Release](https://github.com/bassprofressor-lab/openwolf-enhanced/releases/latest) und öffne es —
Claude Desktop installiert das Bundle und fragt nach deinem Projektverzeichnis. Kein Node nötig, kein
Config-Editieren; das Bundle ist self-contained (~8 KB). Selbst bauen: `pnpm build && pnpm build:mcpb`
→ `dist-mcpb/openwolf.mcpb`.

**Manuell (jeder MCP-Client).** Oder, falls du die `openwolf`-CLI schon installiert hast, trag ihn von
Hand in deine `claude_desktop_config.json` ein:

```json
{
  "mcpServers": {
    "openwolf": {
      "command": "openwolf",
      "args": ["mcp", "--project", "/pfad/zu/deinem/projekt"]
    }
  }
}
```

So oder so stellt er drei **read-only** Tools bereit: `openwolf_recall` (durchsucht das Projekt-Wissen **und**
Claudes native Auto Memory), `openwolf_resume` (der Resume-Digest) und `openwolf_memory_health`.
Die Hook-basierte Auto-Injektion/-Erfassung gilt nur in Claude Code; hier werden die Tools explizit
aufgerufen. OpenWolf schreibt nie in Claudes native Memory — es liest und macht sie sichtbar.

## FAQ

**Sendet OpenWolf meinen Code oder mein Gedächtnis irgendwohin?**
Nein. Alles liegt lokal in einem `.wolf/`-Verzeichnis im Projekt — reines Markdown/JSON, git-nativ, ohne Datenbank und ohne Cloud. Nichts verlässt deinen Rechner. (Die einzigen ausgehenden Calls sind optional: die Hintergrund-AI-Tasks und `openwolf consolidate`, die du auf einen Provider deiner Wahl richtest.)

**Wie unterscheidet sich das vom originalen `openwolf`?**
Dies ist ein gepflegter Fork. Das Original (npm `openwolf`, zuletzt März 2026) ist ungepflegt. Dieser Fork ergänzt begrenzten/selbstwartenden Speicher, BM25-Gedächtnissuche mit Zitaten, einen MCP-Server, modell-agnostische AI-Tasks, Multi-Agent-Support und ~15 Security-Fixes — bleibt aber Drop-in-Ersatz für denselben `openwolf`-Befehl.

**Funktioniert es außer mit Claude Code auch mit anderen Tools?**
Ja. `init`/`update` erkennen **Codex CLI**, **Gemini CLI** und **OpenCode** automatisch und registrieren dieselben Hooks. Der `openwolf mcp`-Server stellt recall/resume zudem für **Claude Desktop** und jeden MCP-Client bereit.

**Brauche ich einen API-Key?**
Für den Kern nicht — Hooks, Gedächtnis, `recall` und `doctor` sind deterministisch und laufen offline. Ein Key wird nur für die optionalen Hintergrund-AI-Tasks und `openwolf consolidate` gebraucht, und die laufen mit jedem Anthropic- oder OpenAI-kompatiblen Provider (auch freien).

**Verlangsamt es meine Sessions?**
Nein. Hooks sind kleine Node-Skripte mit kurzen Timeouts; sie aktualisieren Index und Gedächtnis im Hintergrund und injizieren beim Session-Start einen kompakten, token-begrenzten Digest.

## Voraussetzungen

- Node.js 20+
- Eine Agent-CLI: **Claude Code**, **Codex CLI**, **Gemini CLI** oder **OpenCode** (Claude Code = primäres Ziel)
- Windows, macOS oder Linux
- Optional: PM2 für den persistenten Hintergrund-Daemon/Dashboard
- Optional: ein Anthropic- oder OpenAI-kompatibler API-Key für Cron-AI-Tasks und `openwolf consolidate`
- Optional: `puppeteer-core` für Design-QC-Screenshots

## Einschränkungen

- Claude-Code-Hooks sind ein relativ neues Feature. OpenWolf fällt auf `CLAUDE.md`-Anweisungen zurück, wenn Hooks nicht feuern.
- Token-Tracking ist schätzungsbasiert (Zeichen-zu-Token-Verhältnis), keine exakten API-Zählungen. Genau auf ~15 %.
- `cerebrum.md` hängt davon ab, dass Claude den Anweisungen folgt und es nach Korrekturen aktualisiert. Die Befolgung liegt bei ~85–90 %, nicht 100 %.

## Credits

OpenWolf wurde von [Cytostack Pvt Ltd](https://github.com/cytostack/openwolf) (Farhan Palathinkal Afsal) erstellt. Dieser erweiterte Fork wird von **[Krynex Labs](https://krynexlabs.de)** gepflegt — AI-Engineering & Automatisierung. Großer Dank an die ursprünglichen Autoren für Design und Idee.

## Lizenz

**AGPL-3.0** — wie das Original. Siehe [LICENSE](../../LICENSE) und [NOTICE](../../NOTICE). Als abgeleitetes Werk unter der AGPL bewahrt dieser Fork das ursprüngliche Copyright und bleibt AGPL-3.0; wenn du eine modifizierte Version als Netzwerkdienst betreibst, musst du deren Nutzern den Quellcode zugänglich machen.
