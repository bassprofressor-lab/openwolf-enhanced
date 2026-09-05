# TODO — Learnings aus dem cfetch-Betrieb

> **Herkunft.** Diese Liste ist am 05.09.2026 aus vier Tagen cfetch-Produktivbetrieb entstanden
> (24.172 indizierte Bloecke, ein Rechner) und in dieses Repo kopiert. Sie betrifft
> openwolf-enhanced, wurde aber **nicht hier gemessen** — es wurde in jener Sitzung bewusst kein
> Quelltext dieses Projekts gelesen (Clean-Room gegenueber cfetch). Jeder Punkt nennt deshalb
> zuerst einen Pruefschritt.
>
> Quelle im cfetch-Baum: `todo/active/openwolf-enhanced-learnings/STATUS.md`.

## 🔴 P1 — grosse Wirkung, kleiner Aufwand

### [ ] 1. Standard-Suchmodus (`recall.default_mode`)

- **Beleg aus cfetch:** cfetch nimmt den Modus allein aus dem Flag. Der Index war zu 100 % fertig,
  wurde als solcher gemeldet — und jeder `recall` ohne `--hybrid` blieb lexikalisch. Gemessen an
  8 umformulierten Fragen: **3 brauchbare Antworten in der Standardgrenze 8 ohne Flag, 5 mit.**
- **Hypothese fuer openwolf:** `docs/configuration.md` hat Abschnitte fuer anatomy, token_audit, cron,
  memory, cerebrum, daemon, dashboard, designqc — **keinen fuer `recall`**. Wenn `--semantic` /
  `--hybrid` reine Aufruf-Schalter sind, besteht dieselbe Luecke.
- **Pruefen:** `openwolf recall <begriff>` gegen `openwolf recall --hybrid <begriff>` auf einem
  Projekt mit fertigem Index. Kommen unterschiedliche Trefferlisten? Gibt es einen Konfigschluessel?
- **Fix:** `recall.default_mode` in die Konfiguration, oder bei voller Abdeckung automatisch
  hybrid bevorzugen. Ohne das liegt ein fertiger Index ungenutzt herum.

### [ ] 2. Ledger: Cache-Lesevorgaenge getrennt ausweisen

- **Beleg aus cfetch:** ueber vier Sitzungen 161.950.933 Cache-Reads gegen 1.320 ungecachte
  Eingabe-Token. **Cache-Reads kosten rund ein Zehntel des Eingabepreises**, Cache-Erzeugung rund
  125 %. Ein Report, der das nicht trennt, ueberschaetzt die Ersparnis um etwa Faktor zehn.
- **Pruefen:** Rechnet `openwolf report` mit einem einheitlichen Token-Preis?
- **Fix:** drei Klassen getrennt fuehren (ungecacht / Cache-Read / Cache-Erzeugung) und mit ihren
  Faktoren gewichten. Passt zur eigenen Linie „eine Kennzahl, die nicht schlecht aussehen kann,
  misst nichts" — und macht die Zahl erst belastbar.

### [ ] 3. Zustellung messen, nicht Absenden

- **Beleg aus cfetch:** cfetch meldet „11 Hook-Ausloesungen, **2 nachweislich eingespeist**". Erst diese
  zweite Zahl zeigt, ob der Kontext beim Modell ankam.
- **Hypothese fuer openwolf:** Der Ledger zaehlt beide Seiten (vermiedene Lesevorgaenge und eigene
  Einspeisung) — aber zaehlt er, was ANKAM, oder was GESCHRIEBEN wurde?
- **Pruefen:** Gibt es eine Gegenprobe im Transkript, oder nur die Hook-Ausfuehrung?
- **Fix:** Ausgangszaehler ergaenzen. Direkt aus der eigenen Lehre
  der Lehre „ein Zaehler muss den Ausgang zaehlen" (02.09.2026): ein Zaehler muss den Ausgang zaehlen.

---

## 🟠 P2 — echte Fehler, mittlerer Aufwand

### [ ] 4. Daemon ueberlebt das Update; verwaister Socket blockiert den Neustart

- **Beleg aus cfetch:** Nach `cargo build` lief der Daemon (Start 21:08 des Vortags) weiter mit der ALTEN
  Binary und meldete eine laengst gepatchte Sperre. `daemon stop` beendete den Prozess, liess aber
  den Socket liegen; der folgende `daemon start` sagte `already running`, waehrend `daemon status`
  im selben Atemzug `not running` meldete. Erst `rm -f` des Sockets half.
- **Hypothese fuer openwolf:** openwolf hat einen Daemon (`daemon`-Abschnitt in der Konfigdoku). Bei
  `npm update` / `pnpm update` ist ein weiterlaufender alter Prozess sogar wahrscheinlicher als bei
  einem lokalen Rebuild.
- **Pruefen:** Version aktualisieren, ohne den Daemon anzufassen. Laeuft der alte weiter? Danach
  den Prozess hart beenden und `start` versuchen — was sagt er?
- **Fix:** (a) beim Update den Daemon neu starten oder wenigstens warnen, (b) verwaisten Socket
  erkennen (verbinden statt nur Datei pruefen) und aufraeumen.

### [ ] 5. Qualitaets-Fixtures gegen mehrere Modelle eichen

- **Beleg aus cfetch:** cfetchs mitgeliefertes `semantic_ranking`-Gate wird von **drei** verbreiteten
  Modellen nicht bestanden — embeddinggemma (das Quellmodell des eigenen Profils), bge-m3 und
  nomic-embed-text. Ursache ist das Fixture selbst: der „lexikalische Koeder" handelt inhaltlich
  wirklich vom Thema der Abfrage. Eine Pruefung, die kein verfuegbares Backend besteht, kann einen
  kaputten Aufbau nicht von einem funktionierenden unterscheiden.
- **Hypothese fuer openwolf:** Wo Tests eine Trefferreihenfolge festschreiben, kann dasselbe passieren.
- **Pruefen:** Rangfolge-Erwartungen in `test/` gegen mindestens zwei fremde Embedding-Modelle
  laufen lassen.
- **Fix:** Erwartungen, die nur ein Modell erfuellt, entweder verbreitern oder als
  modellspezifisch kennzeichnen.

---

## 🟡 P3 — strategisch, kein Fehler

### [ ] 6. In die Uebergabe investieren, nicht in die Suche

- **Beleg aus cfetch:** An einem vollen Arbeitstag lag cfetchs Nutzen fast vollstaendig im
  Resume-Digest — die Ring-0-Uebergabe machte nach einer abgebrochenen Sitzung binnen einer Minute
  wieder arbeitsfaehig. Die Suche wurde fuer die eigentliche Arbeit kaum gebraucht, `cfetch find`
  **kein einziges Mal**; gesucht wurde mit `grep`. Zum Vergleich: `raiyanyahya/recall` (744 ★)
  verzichtet bewusst ganz auf Embeddings und liefert nur einen 1–2k-Token-Digest.
- **Folgerung:** „Smart resume" ist das Kronjuwel. Reihenfolge: die Uebergabe traegt den Nutzen,
  die Suche verfeinert ihn.

### [ ] 7. Den Code-Index nicht weiter ausbauen

- **Beleg aus cfetch:** `oraios/serena` (28.842 ★) arbeitet symbolgenau ueber Language Server in 40+ Sprachen
  inkl. Umbenennen ueber echte Aufrufstellen. Der Abstand ist nicht aufzuholen.
- **Folgerung:** `find` auf dem heutigen Stand halten (Zeilenbereiche + PageRank reichen fuer den
  Zweck) und Serena danebenstellen statt nachbauen.

### [ ] 8. Doppelung mit Claudes Auto-Memory pruefen

- Claude Code bringt seit 2.1.59 ein eigenes automatisches Gedaechtnis mit und schreibt selbst eine
  `MEMORY.md`. Laut README liest openwolf-enhanced „Claude's native Auto Memory" bereits mit —
  **also vermutlich erledigt.** Kurz gegenpruefen, ob das noch auf den aktuellen Ablageort passt.

---

## ✅ Nicht noetig — hier bereits behoben

- **Unpaariges `private`-Tag schwaerzt bis Dateiende.** dieses Projekt hat das gefixt (Code-
  Spans und Fences werden vor der Tag-Suche maskiert, vier Tests). **cfetch hatte genau diesen
  Fehler noch** und musste ihn am 04.09. nachziehen (bug-401, 84 % von `cerebrum.md` still aus
  dem Index). Der Lerntransfer laeuft hier in Richtung cfetch, nicht umgekehrt.

---

## Lizenz — gehoert nicht auf diese Liste, aber in dieselbe Entscheidung

Umbenennen loest die AGPL-3.0-only nicht: ein Fork bleibt abgeleitetes Werk, die Lizenz stammt aus
dem Original, und die Git-Historie belegt die Abstammung. Dual-Licensing scheidet aus, weil man
dafuer alle Rechte halten muesste. Zwei Auswege: Erlaubnis von Cytostack Pvt Ltd einholen (kostet
eine E-Mail), oder vollstaendige Neuimplementierung — Letzteres ist cfetch. Keine Rechtsberatung;
bei einer Verwertungsentscheidung fachlich pruefen lassen.
