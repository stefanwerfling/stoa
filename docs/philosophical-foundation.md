# Philosophische Grundlage – Quellen, Interpretationen, Grenzen

> Status: Konzeptphase. Dieses Dokument legt die **methodischen Regeln** der
> Quellenarbeit fest und dokumentiert die bisher geprüften Textstellen.
>
> **Prüfvermerk (Ehrlichkeit über den Prüfstand):** Die unten zitierten
> englischen Wortlaute (George Long, 1862, gemeinfrei) wurden im Rahmen der
> Konzeptphase gegen das *MIT Internet Classics Archive*
> (`classics.mit.edu/Antoninus/…`) geprüft. Die kanonische **Abschnitts­nummerierung**
> (z. B. 8.47) folgt der etablierten Zählung; einzelne Inline-Numerale konnten
> nicht in jedem Fall bildlich bestätigt werden (siehe
> [§6 Unsicherheiten](#6-dokumentierte-unsicherheiten)). Vor einer
> produktiven Nutzung ist jede Stelle gegen eine klar gekennzeichnete
> Long-Ausgabe (MIT/Wikisource/Gutenberg) final zu verifizieren.

## 1. Methodik der Quellenarbeit

Die Vorgaben aus dem Projektauftrag werden als **verbindliche Regeln** umgesetzt:

1. **Drei-Ebenen-Trennung.** Jede Aussage wird einer von drei Ebenen zugeordnet
   und entsprechend markiert:
   - `QUELLE` – belegter Originalgedanke (mit Buch.Abschnitt + Übersetzung).
   - `ÜBERSETZUNG` – Wortlaut einer benannten Übersetzung (Übersetzer + Jahr).
   - `INTERPRETATION` – eigene Deutung des Projekts (klar als solche markiert).
2. **Keine Erfindung.** Keine Textstelle, Kapitelzuordnung oder Aussage wird
   erfunden. Was nicht belegt ist, wird nicht behauptet.
3. **Belegte Fundstelle.** Zitate tragen `Buch.Abschnitt`, Übersetzer und Quelle.
4. **Konfidenz der Zuordnung.** Jede Prinzip-Zuordnung trägt eine
   **Attributions-Konfidenz** (wie sicher stammt der Gedanke von Marc Aurel)
   und eine **Interpretations-Konfidenz** (wie tragfähig ist die technische
   Übertragung). Beide getrennt.
5. **Urheberrecht.** Nur gemeinfreie Wortlaute werden verbatim gespeichert
   (siehe [§3](#3-urheberrechtslage-der-übersetzungen)).
6. **Keine Volltext-Ablage als Prompt/Index.** Es wird **kein** undifferenzierter
   Buchtext gespeichert, sondern eine strukturierte, zitierfähige Wissensbasis
   mit einzelnen Fundstellen und Interpretationen (Datenmodell:
   [knowledge-model.md](./knowledge-model.md)).
7. **Kritische Haltung.** Nicht jeder Gedanke lässt sich sinnvoll in eine
   technische Regel übersetzen. Solche Fälle werden in
   [§5 „Was sich *nicht* übersetzen lässt"](#5-was-sich-nicht-sinnvoll-übersetzen-lässt)
   ausdrücklich festgehalten.

### Warnung vor einem Grundfehler

Marc Aurel schreibt **Ethik und Lebensführung**, nicht Softwaretechnik. Jede
Übertragung ist eine **Analogie**, kein Beweis. Die Engine darf daraus niemals
ableiten, ein Stück Code sei „unstoisch" und deshalb objektiv schlecht. Die
Philosophie liefert einen *Deutungsrahmen für ohnehin technisch begründete
Befunde* – nicht umgekehrt. (Produkt-Leitprinzipien L2, L5.)

## 2. Geprüfte Textstellen (Belegregister)

Wortlaut = **George Long, 1862 (gemeinfrei)**. Die deutsche Spalte ist eine
als solche gekennzeichnete **Arbeitsübersetzung des Projekts** (Ebene
`INTERPRETATION`/`ÜBERSETZUNG` – *keine* zitierte Fremdübersetzung); für
zitierfähiges Deutsch siehe die gemeinfreie Ausgabe in [§3](#3-urheberrechtslage-der-übersetzungen).

| Fundstelle | Long (gemeinfrei, EN) | Arbeitsübersetzung (Projekt, DE) | Status |
|------------|-----------------------|----------------------------------|--------|
| **4.24** | „Occupy thyself with few things, says the philosopher, if thou wouldst be tranquil.— But consider if it would not be better to say, Do what is necessary…" | „Beschäftige dich mit wenigem, … wenn du Ruhe willst. — Doch besser: *Tue das Notwendige.*" | CONFIRMED |
| **4.7** | „Take away thy opinion, and then there is taken away the complaint, 'I have been harmed.' Take away the complaint … and the harm is taken away." | „Nimm das Urteil weg, so ist die Klage ‚mir ist Unrecht geschehen' weg; nimm die Klage weg, so ist der Schaden weg." | CONFIRMED |
| **8.47** | „If thou art pained by any external thing, it is not this thing that disturbs thee, but thy own judgement about it; and it is in thy power to wipe out this judgement now." | „Wenn dich etwas Äußeres schmerzt, so ist es nicht die Sache, sondern dein Urteil darüber; und es steht in deiner Macht, dieses Urteil jetzt zu tilgen." | CONFIRMED |
| **5.20** | „…the mind converts and changes every hindrance to its activity into an aid; and so that which is a hindrance is made a furtherance to an act; and that which is an obstacle on the road helps us on this road." | „…der Geist verwandelt jedes Hindernis seiner Tätigkeit in Förderung; was im Weg steht, wird zum Mittel des Handelns." | CONFIRMED (Wortlaut Long) |
| **6.54** | „That which is not good for the swarm, neither is it good for the bee." | „Was nicht gut ist für den Schwarm, ist auch nicht gut für die Biene." | CONFIRMED |
| **2.1** | „…we are made for co-operation, like feet, like hands, like eyelids…" | „…wir sind zur Zusammenarbeit geschaffen, wie Füße, Hände, Augenlider…" | CONFIRMED |
| **5.1** | „In the morning when thou risest unwillingly, let this thought be present— I am rising to the work of a human being." | „Wenn du morgens ungern aufstehst, denke: Ich erhebe mich zum Werk eines Menschen." | CONFIRMED |
| **8.19** | „Everything exists for some end, a horse, a vine. Why dost thou wonder? Even the sun will say, I am for some purpose…" | „Alles existiert zu einem Zweck – ein Pferd, ein Weinstock … selbst die Sonne: Ich bin zu einem Zweck da." | CONFIRMED |
| **12.17** | „If it is not right, do not do it: if it is not true, do not say it." | „Ist es nicht recht, tu es nicht; ist es nicht wahr, sag es nicht." | CONFIRMED |
| **12.22** | „Consider that everything is opinion, and opinion is in thy power. Take away then, when thou choosest, thy opinion…" | „Bedenke: Alles ist Meinung, und Meinung steht in deiner Macht. Nimm sie weg, wann du willst…" | CONFIRMED |
| **6.8** | „the ruling faculty … makes itself such as it is and such as it wills to be, and it makes everything which happens appear to itself such as it wills." | „Das leitende Vermögen formt sich selbst und deutet jedes Geschehen so, wie es will." | CONFIRMED |
| **5.19** | „Things themselves touch not the soul … nor can they turn or move the soul…" | „Die Dinge selbst berühren die Seele nicht … sie bewegen die Seele nicht." | CONFIRMED |

### Wichtige Korrekturen (dokumentiert, weil es leicht falsch gemacht wird)

- **5.20 – nicht die populäre Fassung zitieren.** Die bekannte Formulierung
  *„The impediment to action advances action. What stands in the way becomes the
  way."* stammt aus der **modernen, urheberrechtlich geschützten** Übersetzung
  von **Gregory Hays (2002)** und wurde durch Ryan Holiday populär. Sie ist
  **nicht** gemeinfrei. Wir zitieren ausschließlich den Long-Wortlaut oben.
- **2.1 ≠ 2.5.** „do every act of thy life as if it were the last" ist **2.5**;
  die Liste „Begin the morning … the busy-body, the ungrateful…" ist **2.1**.
  (2.1 enthält auch den Kooperations-Satz, den wir nutzen.)
- **6.2** wurde **nicht** verifiziert und wird daher **nicht** als Beleg genutzt.

## 3. Urheberrechtslage der Übersetzungen

| Ausgabe | Sprache | Status | Nutzung in *stoa* |
|---------|---------|--------|-------------------|
| Griechisches Original (Antike) | GR | gemeinfrei | Referenz |
| **George Long, 1862** | EN | **gemeinfrei** | **primärer zitierfähiger Basistext** |
| Méric Casaubon, 1634 | EN | gemeinfrei | nutzbar (archaisch) |
| Jackson 1906 / Collier 1701 / Rendall 1898 | EN | gemeinfrei | optional |
| **Gregory Hays, 2002** | EN | **© geschützt** | **nicht verbatim** |
| Robin Hard, Hammond, Farquharson | EN | © geschützt | nicht verbatim |
| **A. von Gleichen-Russwurm** (Übers. † 1947) | DE | **gemeinfrei** (Gutenberg 15028; DE PD seit 2018) | **zitierfähiger DE-Basistext** |
| Wittstock / Cless (19. Jh.) | DE | *sehr wahrscheinlich* gemeinfrei | nur nach Prüfung der konkreten Ausgabe |
| **Otto Kiefer** (Übers. † 1957) | DE | **wahrscheinlich noch © (bis Ende 2027)** | **nicht** als gemeinfrei behandeln |
| Reclam / Krapinger u. a. | DE | © geschützt | nicht verbatim |

**Konsequenz für die Wissensbasis:** verbatim gespeichert wird nur Long (EN)
und – falls deutscher Volltext gewünscht – Gleichen-Russwurm (DE). Alles andere
nur als Fundstellen-Referenz oder als projekteigene Arbeitsübersetzung.

## 4. Abgeleitete Prinzipien (Übersicht)

Sechs Prinzipien bilden die MVP-Wissensbasis. Jedes ist in
[knowledge-model.md](./knowledge-model.md#beispielprinzipien) vollständig
ausgearbeitet (Interpretation, Hypothese, Analyse, Beispiele, Grenzen).

| Prinzip-ID | Kurzname | Belegstellen | Attributions-Konfidenz | Technisches Feld |
|------------|----------|--------------|------------------------|------------------|
| `marcus.simplicity` | Maßhalten / das Notwendige tun | 4.24 | hoch | Unnötige Komplexität |
| `marcus.purpose` | Zweck & Aufgabe | 8.19; 5.1 | mittel–hoch | Unklare Verantwortlichkeiten |
| `marcus.control` | Das Eigene / die Urteilskraft | **primär Epictetus Ench. 1**; Marc Aurel: 12.22, 6.8, 5.19, 8.56 | **niedrig für Marc Aurel** | Unkontrollierte Seiteneffekte |
| `marcus.obstacle` | Hindernis → Förderung | 5.20 | hoch | Fehlerunterdrückung |
| `marcus.cooperation` | Dem Ganzen dienen | 6.54; 2.1 | hoch | Unnötige/falsche Abhängigkeiten |
| `marcus.judgment` | Prüfung der Urteile | 4.7; 8.47; 12.17 | hoch | Architektur ↔ Verhalten; **Meta-Prinzip** |

### Wichtiger Ehrlichkeitsvermerk zu `marcus.control`

Die **„Dichotomie der Kontrolle"** (nur das betreffen, was in unserer Macht
steht) ist in ihrer klaren Form **Epiktet, *Encheiridion* 1** – **nicht** Marc
Aurel. Marc Aurel teilt die stoische Grundhaltung und drückt Verwandtes aus
(12.22, 6.8, 5.19, 8.56), formuliert die Dichotomie aber nicht als Lehrsatz.
Deshalb trägt `marcus.control` eine **niedrige Attributions-Konfidenz zu Marc
Aurel** und verweist Epiktet als Primärquelle. Dies ist genau der Typ
unsicherer Zuordnung, den die Methodik sichtbar machen soll – und zugleich ein
Testfall für die geplante **Mehr-Werke-Erweiterbarkeit** (Epiktet als zweite
Quelle, siehe [knowledge-model.md](./knowledge-model.md)).

## 5. Was sich *nicht* sinnvoll übersetzen lässt

Ausdrücklich dokumentierte **Nicht-Übertragungen** (verhindern Überdehnung):

- **Tod/Vergänglichkeit** (z. B. 2.5, 4.48): ethisch zentral, aber keine
  tragfähige, nicht-triviale Code-Regel. (Gefahr platter Analogien wie „toter
  Code = Memento mori".) → **keine Regel.**
- **Umgang mit schwierigen Menschen** (2.1 Anfang): sozial/teambezogen, nicht
  aus Quellcode ableitbar. → **keine Regel.**
- **Gleichmut gegenüber Lob/Tadel**: nicht statisch messbar. → **keine Regel.**
- **Kosmische Vernunft / Logos**: metaphysisch; jede technische Entsprechung
  wäre reine Projektion. → **keine Regel.**

Diese Liste ist Teil der Qualitätssicherung: Ein Prinzip ohne tragfähige,
belegbare technische Hypothese wird **nicht** zur Regel.

## 6. Dokumentierte Unsicherheiten

1. **Inline-Abschnittsnummern** in Buch 8 (8.19/8.47/8.56) folgen der kanonischen
   Zählung; der Wortlaut ist bestätigt, einzelne Numerale wurden nicht bildlich
   gegengeprüft. → vor Produktivnutzung final verifizieren.
2. **6.2** unbestätigt → nicht verwendet.
3. **Konkrete Druckausgaben** von Wittstock/Cless: PD nach Alter sehr
   wahrscheinlich, aber nicht einzeln bestätigt.
4. Eine früher versuchte Gutenberg-Ausgabe (ebook 2680) lieferte abweichenden,
   abgeschnittenen Text; sie wird **nicht** als Beleg genutzt. Basis ist
   MIT/Wikisource/klar gekennzeichnete Long-Ausgabe.

## 7. Prozess für neue Belege/Prinzipien

1. Fundstelle + gemeinfreie Übersetzung erfassen; Ebene markieren
   (`QUELLE`/`ÜBERSETZUNG`/`INTERPRETATION`).
2. Attributions- und Interpretations-Konfidenz getrennt vergeben.
3. Technische Hypothese + mind. ein Gegenbeispiel formulieren; sonst verwerfen
   (→ §5).
4. Experten-Review der Interpretation (siehe [evaluation.md](./evaluation.md#6-experten-review)).
5. Versionierung in der Wissensbasis (Änderungshistorie).
