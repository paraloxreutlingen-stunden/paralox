# Paralox Stundenverwaltung

Interne Betriebssoftware zur Erfassung von Arbeitszeiten in einem
Kleinbetrieb: Mitarbeiter tragen ihre Schichten ein, die Anwendung
berechnet Verdienste, teilt Kosten auf die Eigentümer auf und erzeugt die
Unterlagen für die Lohnabrechnung geringfügig Beschäftigter
(Minijob-Abrechnung, CSV-/ODS-/PDF-Auswertungen, verschlüsselte
Sicherungen).

Es handelt sich nicht um ein Produkt, sondern um eine auf einen einzelnen
Betrieb zugeschnittene Anwendung. Sie enthält Annahmen, die anderswo nicht
zutreffen — etwa zur Kostenaufteilung, zu den Beitragssätzen der
Minijob-Zentrale und zur Berechnung von Urlaubsentgelt.

## Nutzung

**Dieser Code ist öffentlich einsehbar, aber nicht zur Nutzung
freigegeben.** Kopieren, Verändern, Weitergeben und Betreiben sind ohne
schriftliche Zustimmung nicht gestattet. Einzelheiten und die Ausnahmen
für mitgelieferten Fremdcode stehen in [LICENSE](LICENSE).

Wer eine Stundenverwaltung sucht, ist mit einer der vielen freien Lösungen
besser bedient — dieses Repository ist offen, weil die Anwendung über
GitHub Pages ausgeliefert wird, nicht als Einladung zur Übernahme.

## Technisch

Vanilla JavaScript ohne Framework, als PWA ausgeliefert. Die Daten liegen
ausschließlich im `localStorage` des jeweiligen Geräts; es gibt keinen
Server und keine Datenübertragung an Dritte. Ausgeliefert wird ein
Single-File-Bundle, das aus den Quelldateien gebaut wird:

```bash
node build-bundle.js
```

Hinweise zu Aufbau, Datenmodell und Tests stehen in
[CLAUDE.md](CLAUDE.md).

---

**English:** Internal time-tracking software for a single small business.
Publicly visible, but **not licensed for use** — see [LICENSE](LICENSE).
The repository is public because the app is served via GitHub Pages, not
as an invitation to reuse it.
