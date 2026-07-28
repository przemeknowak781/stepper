# SPEC: `meshfix` — deterministyczna naprawa siatek pod druk 3D

Wersja specyfikacji: **1.2**
Odbiorca: agent kodujący (Claude Code lub równoważny)
Język implementacji: Python 3.11+, z jednym opcjonalnym komponentem C++

---

## 0. Instrukcja dla agenta

Przeczytaj całą specyfikację przed napisaniem pierwszej linii kodu. Ta specyfikacja podaje nazwy funkcji bibliotecznych z pamięci autora i **część z nich może być nieaktualna**. Obowiązuje zasada: przed użyciem dowolnego filtra PyMeshLab zweryfikuj jego nazwę i sygnaturę w zainstalowanej wersji (`pymeshlab.print_filter_list()`, `pymeshlab.print_filter_parameter_list(nazwa)`). To samo dotyczy API `trimesh`. Jeśli nazwa się nie zgadza, popraw ją i odnotuj w `NOTES.md`, nie zgaduj i nie obchodź problemu przez `try/except pass`.

Nie implementuj kroków w kolejności innej niż podana w sekcji 11. Każdy kamień milowy ma kończyć się przechodzącymi testami.

---

## 0.1 Changelog 1.0 → 1.1

Zmiany wynikają z przeglądu wersji 1.0. Każda ma uzasadnienie, bo część z nich zmienia zachowanie centralnych mechanizmów.

| # | Zmiana | Powód |
|---|---|---|
| C1 | **A8 liczone dwustronnie** (`max(in→out, out→in)`), a nie jednostronnie `out→in`. §2, §7.2 | `out→in` jest dla alpha wrappingu małe **z konstrukcji** (~`offset`), więc próg 0,5% przekątnej był spełniony już przez najgrubszą alfę. Drabinka doboru alfy z §7.2 zwracała pierwszego kandydata przy pierwszej iteracji i pozostałe cztery były martwym kodem. Kierunek `in→out` mierzy faktyczną utratę detalu (zaklejony rowek o głębokości *d* daje *d*). |
| C2 | **Nowa detekcja powłoki** (`shell_score` w `Diagnosis`, kryterium A10, opcja `--shell-thickness`). §5, §5.3, §7.6 | Alpha wrap na otwartej powłoce (typowe dla siatek z AI) po cichu produkuje płytę o grubości `2·offset = alpha/15` — liczbę wziętą znikąd. To jest dokładnie „prawie się udało" zakazane w §1.1. |
| C3 | **A9 domyślnie wyłączone**; `--min-wall` bez wartości domyślnej, wymaga `--units`. §2, §3 | `--min-wall 0.8` zakładało milimetry, których STL nie przenosi. Model w metrach dostawał próg 0,8 m. Grubość ścianki jest ograniczeniem drukarki, więc bez jednostek nie jest kryterium, tylko metryką. |
| C4 | **`voxel_size` liczone z docelowej rozdzielczości**, nie z `p01(edge_length)`. §7.3 | p01 długości krawędzi jest zdominowane przez slivery, czyli dokładnie te artefakty, które usuwamy. W praktyce zawsze działał dolny clamp, więc parametr nie był sterowany geometrią. |
| C5 | **A9 przez stożek promieni (SDF)**, nie pojedynczy promień. §7.5 | Pojedynczy promień wzdłuż −normal systematycznie zawyża dla ścianek zbieżnych i skośnych. Stożek + ważona mediana to Shape Diameter Function, ten sam rząd kosztu. |
| C6 | **Poisson z obowiązkowym przycinaniem po gęstości.** §7.4 | Screened Poisson ekstrapoluje powierzchnię poza dane; bez progowania po skalarze `density` produkuje balony, które masowo oblewają A8. |
| C7 | **Determinizm zawężony do ustalonego builda.** §1.1 | Predykaty CGAL są dokładne, ale współrzędne punktów Steinera to zmiennoprzecinek; bit-identyczność między architekturami/kompilatorami (FMA, `-ffast-math`) nie jest dana. |
| C8 | **Doprecyzowana idempotencja**: postprocessing biegnie zawsze, decymacja jest pomijana gdy `n_faces <= target_faces`. §8, §10.2 | Bez tego drugi przebieg z `--target-faces` decymowałby ponownie i hasze by się rozjechały. |
| C9 | **Tolerancja `merge_vertices` związana z reprezentacją**: `max(diag*1e-8, ulp_float32(diag))`. §8 | `diag*1e-8` leży poniżej rozdzielczości float32 (dla `diag≈173` ulp ≈ 7,6e-6), więc po round-tripie przez STL weld mógł po cichu nic nie robić. |
| C10 | **`decimation_reverted` trafia na stdout**, nie tylko do JSON. §8, §9 | A5 jest twarde, a decymacja quadric notorycznie wprowadza samoprzecięcia, więc cofnięcie będzie częste. Użytkownik prosił o mniej ścian i musi wiedzieć, że ich nie dostał. |
| C11 | **Test wierzchołków non-manifold rozpisany** (link wierzchołka = jeden zamknięty wachlarz). §5.2 | `trimesh` nie daje tego wprost, więc łatwo ten warunek A2 po cichu pominąć. |
| C12 | §7.2 nazwane **drabinką (ladder search)**, nie bisekcją. §7.2 | To skan liniowy po rosnącym N. Nazwa myliła. |
| C13 | **Konflikt `--backend` z `--fallback-chain` to błąd** (kod 2). §3, §6 | Wcześniej niezdefiniowane. |
| C14 | **Niedostępność `aw3` ląduje w `warnings` raportu.** §6, §9 | Wynik z fallbacku jest istotnie gorszy; to musi być widoczne w artefakcie, nie tylko w logu. |
| C15 | **Seed jawnie przekazywany do wszystkich samplerów.** §1.1, §12.1 | Próbkowanie występuje w Hausdorffie, SDF i Poissonie; „domyślnie 0" nic nie znaczy, jeśli sampler go nie przyjmuje. |

---

## 1. Cel

Narzędzie CLI i biblioteka Pythona, które przyjmuje uszkodzoną siatkę powierzchniową (typowo wygenerowaną przez model AI albo przez rekonstrukcję powierzchni) i produkuje siatkę spełniającą twarde kryteria drukowalności, wraz z ilościowym raportem utraty wierności geometrycznej.

### 1.1 Cele niefunkcjonalne

- **Determinizm.** Ten sam plik wejściowy i te same parametry dają bit-identyczne wyjście **w obrębie ustalonego builda** (ta sama wersja Pythona, tych samych bibliotek i ta sama binarka `aw3`). Bit-identyczność między architekturami CPU i wersjami kompilatora nie jest gwarantowana i nie jest testowana; CI przypina toolchain. Żadnych losowych ziaren bez jawnego seedowania — każdy sampler (Hausdorff, SDF, Poisson) przyjmuje `seed` jako parametr, nie czyta globalnego stanu RNG.
- **Mierzalność.** Każdy etap raportuje metryki przed i po. Narzędzie nigdy nie twierdzi, że naprawiło model, bez przedstawienia dowodu.
- **Uczciwa porażka.** Jeśli kryteria akceptacji nie zostały spełnione, narzędzie kończy się kodem wyjścia różnym od zera i mówi, który warunek nie przeszedł. Nie ma trybu „prawie się udało".

### 1.2 Poza zakresem (non-goals)

- Rekonstrukcja topologii czworokątnej, edge flow, retopologia pod animację.
- Zachowanie UV, materiałów, grup wygładzania. Wejście traktujemy jako czystą geometrię.
- Generowanie podpór, orientowanie pod druk, slicing.
- Jakakolwiek warstwa LLM. Narzędzie jest w całości deterministyczne.

---

## 2. Definicja sukcesu (kryteria akceptacji)

Siatka wyjściowa jest **zaakceptowana** wtedy i tylko wtedy, gdy wszystkie aktywne warunki są spełnione jednocześnie:

| ID | Warunek | Pomiar | Klasa |
|---|---|---|---|
| A1 | Wodoszczelność | `trimesh.Trimesh.is_watertight is True` | twarde |
| A2 | 2-manifold | zero krawędzi o liczbie incydentnych ścian różnej od 2, zero wierzchołków non-manifold (§5.2) | twarde |
| A3 | Spójna orientacja | `is_winding_consistent is True` | twarde |
| A4 | Objętość dodatnia | `volume > 0` | twarde |
| A5 | Brak samoprzecięć | zero par przecinających się trójkątów (test niesąsiadujących) | twarde |
| A6 | Brak degeneracji | zero ścian o polu poniżej `eps_area`, zero krawędzi krótszych niż `eps_len` | twarde |
| A7 | Liczba składowych | równa `--expected-components` (domyślnie 1) | twarde |
| A8 | Wierność | **dwustronny** Hausdorff `max(in→out, out→in)` poniżej `--max-deviation` | ostrzeżenie / `--strict` |
| A9 | Grubość ścianki | szacowana grubość powyżej `--min-wall` (§7.5) | **nieaktywne bez `--min-wall`** |
| A10 | Wejście jest bryłą | `shell_score < 0.5` albo podano `--shell-thickness` (§5.3) | twarde na **wejściu** |

**A8 jest dwustronne (C1).** `out→in` mierzy, czy wyjście ma materiał daleko od wejścia (napompowanie, mostkowanie szerokiej szczeliny). `in→out` mierzy, czy wejście ma detal nieobecny w wyjściu (zaklejony rowek, zgubiona cecha) — to jest charakterystyczny tryb awarii zarówno alpha wrappingu, jak i backendów voxel i poisson. Raport podaje obie liczby osobno oraz maksimum, i to maksimum jest porównywane z progiem.

**A9 jest nieaktywne, dopóki użytkownik nie poda `--min-wall` (C3).** Bez tego `min_wall_estimate` trafia do raportu jako metryka z `approximate: true`, ale nie jest kryterium. Grubość ścianki to ograniczenie drukarki wyrażone w jednostkach fizycznych, a plik STL nie przenosi jednostek — narzędzie nie ma prawa zgadywać, że model jest w milimetrach.

**A10 jest sprawdzane na wejściu, nie na wyjściu (C2).** Szczegóły w §5.3.

A1–A7 i A10 są twarde. A8 jest ostrzeżeniem domyślnie, a błędem przy `--strict`. A9 jest błędem tylko przy jednoczesnym `--min-wall` i `--strict`.

---

## 3. Interfejs CLI

Od wersji 1.2 CLI ma dwie podkomendy, bo doszła usługa lokalna (§16):
`meshfix fix INPUT [OPTIONS]` oraz `meshfix serve [OPTIONS]`.

```
meshfix fix INPUT [OPTIONS]

Argumenty pozycyjne:
  INPUT                     ścieżka do pliku wejściowego (.stl .obj .ply .off .3mf .glb)

Wyjście:
  -o, --output PATH         ścieżka pliku wyjściowego (domyślnie: INPUT_fixed.stl)
  --report PATH             ścieżka raportu JSON (domyślnie: obok wyjścia, .report.json)
  --keep-intermediates DIR  zapisz siatki pośrednie z każdego etapu

Wybór strategii:
  --backend {auto,alphawrap,voxel,ftetwild,poisson}
                            domyślnie: auto (patrz sekcja 6)
  --fallback-chain LIST     kolejność prób, np. "alphawrap,voxel,poisson"
                            KONFLIKT: podanie razem z --backend innym niż auto = błąd (kod 2)

Parametry geometryczne (w jednostkach modelu; sufiks % oznacza ułamek przekątnej bbox):
  --alpha FLOAT             alpha dla alphawrap; domyślnie auto (drabinka, §7.2)
  --offset FLOAT            offset dla alphawrap; domyślnie alpha/30
  --voxel-resolution INT    liczba wokseli na przekątną bbox; domyślnie 256
  --voxel-size FLOAT        jawny rozmiar woksela; nadpisuje --voxel-resolution
  --max-deviation FLOAT     próg dla A8; domyślnie 0.5% przekątnej bbox
  --min-wall FLOAT          próg dla A9; BRAK WARTOŚCI DOMYŚLNEJ, aktywuje A9
  --units {mm,cm,m,in}      jednostka modelu; wymagana razem z --min-wall
  --shell-thickness FLOAT   pogrubienie otwartej powłoki do bryły (§7.6)
  --target-faces INT        docelowa liczba trójkątów po decymacji; 0 = bez decymacji

Kontrola:
  --expected-components INT domyślnie 1
  --strict                  traktuj A8 (i A9, jeśli aktywne) jako błędy
  --dry-run                 tylko diagnostyka wejścia, bez naprawy
  --seed INT                domyślnie 0
  -v, -vv                   poziom logowania
```

Kody wyjścia:

- `0` zaakceptowano
- `1` nie spełniono kryterium twardego po wyczerpaniu fallback chain
- `2` błąd wejścia/wyjścia, nieobsługiwany format, sprzeczne argumenty
- `3` brakująca zależność (np. binarka `aw3` niedostępna, a backend wymuszony flagą)

---

## 4. Architektura modułów

```
meshfix/
  __init__.py
  cli.py                 # parsowanie argumentów, orkiestracja, kody wyjścia
  io.py                  # wczytywanie i zapis, deterministyczna serializacja
  diagnose.py            # sekcja 5, czysto odczytowe
  backends/
    __init__.py          # rejestr backendów, wspólny protokół
    alphawrap.py         # wrapper na binarkę C++
    voxel.py             # Blender headless lub OpenVDB
    ftetwild.py          # wrapper na binarkę fTetWild
    poisson.py           # PyMeshLab screened Poisson
  postprocess.py         # decymacja, czyszczenie degeneracji, pogrubianie powłoki
  validate.py            # sekcja 2, kryteria A1..A10
  metrics.py             # Hausdorff, Chamfer, grubość ścianki (SDF)
  report.py              # serializacja raportu JSON i podsumowanie tekstowe
cpp/
  aw3_cli.cpp            # sekcja 7.1
  CMakeLists.txt
tests/
  fixtures/              # sekcja 10.1
  test_*.py
```

### 4.1 Protokół backendu

```python
class Backend(Protocol):
    name: str
    def available(self) -> tuple[bool, str]:
        """Czy backend da się uruchomić. Drugi element to powód niedostępności."""
    def suggest_params(self, mesh: trimesh.Trimesh, ctx: RunContext) -> dict:
        """Automatyczny dobór parametrów na podstawie geometrii wejścia."""
    def run(self, input_path: Path, output_path: Path, params: dict,
            log: Logger) -> BackendResult:
        """Wykonanie. Musi być deterministyczne."""
```

`BackendResult` to dataclass: `success: bool`, `output_path: Path | None`, `wall_time_s: float`, `params_used: dict`, `stdout_tail: str`, `message: str`.

`RunContext` niesie `seed`, `max_deviation`, `bbox_diagonal` i pozostałe parametry globalne, żeby `suggest_params` nie czytało stanu globalnego (C15).

Backendy nie wolno importować nawzajem. Orkiestracja żyje wyłącznie w `cli.py`.

---

## 5. Moduł diagnostyczny

`diagnose.analyze(mesh) -> Diagnosis`. Czysto odczytowy, **nie modyfikuje siatki wejściowej** (pracuj na kopii, jeśli jakakolwiek operacja wymaga mutacji).

```python
@dataclass
class Diagnosis:
    n_vertices: int
    n_faces: int
    bbox: list[float]              # [minx,miny,minz,maxx,maxy,maxz]
    bbox_diagonal: float
    is_watertight: bool
    is_winding_consistent: bool
    is_volume: bool
    volume: float | None
    area: float
    euler_number: int
    genus: int | None              # None gdy nie 2-manifold lub >1 składowa
    n_components: int
    n_boundary_edges: int
    n_nonmanifold_edges: int
    n_nonmanifold_vertices: int
    n_selfintersecting_faces: int
    n_degenerate_faces: int
    n_duplicate_vertices: int
    n_unreferenced_vertices: int
    edge_length_percentiles: dict  # {"p01":..,"p50":..,"p99":..}
    face_area_percentiles: dict
    min_dihedral_angle_deg: float
    shell_score: float             # 0 = pełna bryła, 1 = otwarta powłoka (§5.3)
    verdict: str                   # "printable" | "repairable" | "severe" | "shell"
```

### 5.1 Reguły klasyfikacji `verdict`

- `printable`: spełnione A1 do A7 dla wejścia.
- `shell`: `shell_score >= 0.5` (§5.3). Ma pierwszeństwo przed `severe`.
- `severe`: `n_selfintersecting_faces > 0.05 * n_faces` **lub** `n_components > 20` **lub** `n_nonmanifold_edges > 0.02 * n_faces`. Wymusza backend `alphawrap`.
- `repairable`: pozostałe przypadki.

Progi w regule `severe` są wstępne i mają zostać skalibrowane na fixtures w M1; wynik kalibracji trafia do `NOTES.md` i z powrotem do tej sekcji.

### 5.2 Uwagi implementacyjne

- **Krawędzie non-manifold**: policz incydencje w `mesh.edges_sorted` i policz krawędzie o liczności różnej od 2. Nie polegaj na pojedynczej właściwości `trimesh`.
- **Wierzchołki non-manifold (C11)**: `trimesh` nie udostępnia tego wprost i łatwo ten warunek pominąć. Test: dla każdego wierzchołka zbierz incydentne ściany i zbuduj z ich przeciwległych krawędzi graf; wierzchołek jest manifoldowy wtedy i tylko wtedy, gdy te krawędzie tworzą **dokładnie jeden zamknięty cykl** (jeden wachlarz). Dwa cykle to klasyczna „muszka" (bowtie), która przechodzi test krawędziowy i mimo to łamie A2.
- **Samoprzecięcia**: `trimesh.repair.broken_faces` **nie jest** testem samoprzecięć, tylko testem spójności nawinięcia. Do samoprzecięć użyj testu opartego na drzewie AABB z wykluczeniem par trójkątów dzielących wierzchołek. **Nie mieszaj tych dwóch pojęć w raporcie.**
- `genus` licz tylko gdy A2 spełnione i jedna składowa: `g = (2 - euler) / 2`.
- Wszystkie percentyle liczone deterministycznie (`numpy.percentile` z ustalonym `method`).

### 5.3 Detekcja powłoki (`shell_score`, kryterium A10) — nowe w 1.1

**Problem.** Wejściem bywa otwarta powłoka bez grubości: karoseria, płat, skan jednostronny. To najczęstszy przypadek dla siatek generowanych przez AI. Alpha wrapping nie zgłosi na tym błędu — wyprodukuje zamkniętą płytę o grubości `2·offset = alpha/15`, czyli wartości wynikającej z parametru regularyzacji, a nie z intencji użytkownika. Wynik przejdzie A1–A7 i będzie bezużyteczny.

**Miara** (skalibrowana na fixtures w M1; szczegóły pomiarów w `NOTES.md` §3.2).

Otwarty brzeg jest **warunkiem koniecznym**, a wynikiem jest `thinness`:

```
shell_score = 0.0        gdy siatka jest zamknięta (n_boundary_edges == 0)
shell_score = thinness   w przeciwnym razie

thinness = 1 - min(1, (6*sqrt(pi)*|V|) / A^{3/2})
```

`thinness` to bezwymiarowy iloraz izoperymetryczny: dla kuli wyrażenie daje 1, więc `thinness = 0`; dla nieskończenie cienkiego płata `|V| → 0`, więc `thinness → 1`. `|V|` liczone jako moduł objętości ze wzoru dywergencji, więc pozostaje sensowne także na siatce otwartej (przybliżenie, tak oznaczone).

**Wersja robocza 1.1 używała `max(min(1, 4*boundary_ratio), thinness)` i była błędna w dwóch niezależnych miejscach:**

1. `boundary_ratio` mierzy gęstość teselacji, nie „powłokowość", i na parze, którą ma rozdzielać, sygnał jest **odwrócony**: `open_shell` (prawdziwy płat) ma 80/1240 = 0,065, a `open_cube` (masywna bryła bez jednej ściany) 4/18 = 0,22. Gęsto steselowana powłoka ma *niski* stosunek brzegu. Przy wzmocnieniu 4 `open_cube` dostawał 0,89 i był odrzucany jako powłoka.
2. Na siatce **zamkniętej** objętość dywergencyjna jest zaburzona przez niespójne nawinięcie, więc `flipped_normals` — pełna kula, której jedyną wadą jest 30% odwróconych ścian — dostawał `thinness = 0,60` i był klasyfikowany jako powłoka. Siatka zamknięta z definicji zamyka objętość; to, czy ta objętość jest cienka, jest pytaniem A9, a nie A10 (to naprawia też `thin_shell`, czyli zamkniętą płytę 0,2).

**Zachowanie.**

- `shell_score < 0.5` → A10 spełnione, normalna ścieżka.
- `shell_score >= 0.5` bez `--shell-thickness` → **odmowa**, kod 1, komunikat:
  `REJECTED: A10 input is an open shell (shell_score=0.82), not a solid. Re-run with --shell-thickness T to give it a wall, or fix the source model.`
- `shell_score >= 0.5` z `--shell-thickness T` → pogrubienie (§7.6) przed właściwym backendem, `shell_thickened` w `warnings`.

Progi (0.5, mnożnik 4 przy `boundary_ratio`) są wstępne i podlegają kalibracji na fixtures `thin_shell` i `ai_like_blob` w M1.

---

## 6. Logika wyboru backendu (`--backend auto`)

```
jeśli --backend != auto i podano --fallback-chain:
    błąd, kod 2                                             # C13
jeśli --backend != auto:
    chain = [ten backend]
w przeciwnym razie jeśli verdict == "printable" i target_faces == 0:
    pomiń naprawę, przejdź do postprocessingu i walidacji
w przeciwnym razie jeśli verdict == "severe" lub verdict == "shell":
    chain = [alphawrap, voxel]
w przeciwnym razie:
    chain = [alphawrap, voxel, poisson]

jeśli alphawrap niedostępny (brak binarki):
    usuń z chain
    zaloguj WARNING z instrukcją budowy (§7.1)
    dopisz "alphawrap_unavailable" do warnings raportu       # C14
```

Orkiestracja próbuje backendy po kolei. Po każdym uruchamia pełną walidację. Pierwszy, który przechodzi kryteria twarde, wygrywa. Jeśli żaden nie przejdzie, narzędzie zwraca wynik backendu o **najmniejszej liczbie naruszonych kryteriów twardych** (remis rozstrzyga niższy dwustronny Hausdorff), oznacza go w raporcie jako `accepted: false` i kończy kodem 1.

Jeśli `n_components != --expected-components` już na wejściu, zaloguj to jako wskazówkę **przed** uruchomieniem łańcucha, żeby użytkownik nie czekał na przemielenie wszystkich backendów tylko po to, by dostać naruszenie A7.

---

## 7. Specyfikacja backendów

### 7.1 `alphawrap` (podstawowy)

Opiera się na CGAL 3D Alpha Wrapping (pakiet dostępny od CGAL 5.5; Portaneri, Hemmer, Rineau, Alliez, SIGGRAPH 2022). Gwarantuje wyjście wodoszczelne, 2-manifoldowe, wolne od przecięć i ściśle zawierające wejście, bez żadnych założeń o spójności wejścia.

**Nie używaj gotowego przykładu CGAL jako CLI.** Jego interfejs opiera się na parametrach względnych i domyślnych nazwach plików wyjściowych, co łamie wymóg determinizmu i utrudnia testowanie. Napisz własny cienki wrapper `cpp/aw3_cli.cpp` o jawnym interfejsie:

```
aw3 --input FILE --output FILE --alpha FLOAT --offset FLOAT
```

Punkt startowy do skopiowania: `Alpha_wrap_3/examples/Alpha_wrap_3/triangle_soup_wrap.cpp` z repozytorium CGAL (zweryfikuj ścieżkę w aktualnym drzewie). Wariant dla zupy trójkątów, nie dla siatki, bo wejście nie jest spójne.

Wymagania budowy: CGAL 5.5+ (header-only), Boost, Eigen, CMake 3.12+. `cpp/CMakeLists.txt` ma budować pojedynczy target `aw3`. Dostarcz `scripts/build_aw3.sh`. Binarka ma trafiać do `meshfix/bin/aw3` i być wykrywana przez `shutil.which` oraz przez ścieżkę względną w pakiecie.

Jeśli budowa nie jest możliwa w środowisku CI, testy tego backendu mają być oznaczone `@pytest.mark.skipif` z jasnym powodem, a nie wyciszone.

### 7.2 Automatyczny dobór `alpha` — drabinka (ladder search)

`alpha` steruje tym, które wklęsłości i szczeliny zostaną odtworzone. Zbyt duża zakleja detal, zbyt mała przepuszcza defekty i eksploduje liczbę trójkątów.

```
diag = bbox_diagonal
kandydaci N = [60, 100, 150, 250, 400]     # alpha = diag / N
dla każdego N w rosnącej kolejności:        # od najgrubszej alfy do najdrobniejszej
    alpha = diag / N
    offset = alpha / 30
    uruchom aw3
    jeśli walidacja twarda przechodzi ORAZ hausdorff_dwustronny <= max_deviation:
        zwróć te parametry
    jeśli liczba ścian wyniku > 20 * liczba ścian wejścia:
        przerwij pętlę (alpha za mała, wynik zdegenerowany)
zwróć najlepszy wynik według liczby naruszeń, potem według hausdorffa dwustronnego
```

**Dlaczego dwustronny (C1).** Przy kryterium jednostronnym `out→in` ta pętla była martwa: dla `alpha = diag/60` mamy `offset = diag/1800 ≈ 0,055%` przekątnej, czyli grubo poniżej domyślnego progu 0,5%, a alpha wrap z definicji przechodzi A1–A7. Pierwszy kandydat wygrywał zawsze, dając maksymalną utratę detalu przy komfortowo wyglądającej metryce. Kierunek `in→out` rośnie wraz z alfą (zaklejony rowek o głębokości *d* daje *d*), więc dopiero on sprawia, że drabinka realizuje swój zamysł: zacznij tanio i grubo, zacieśniaj aż wierność wejdzie w próg.

Ta pętla ma być wyłączana flagą `--alpha` podaną jawnie. Zaloguj każdą iterację z czasem, liczbą ścian i obiema odległościami Hausdorffa, bo to jest główny koszt czasowy narzędzia.

### 7.3 `voxel` (fallback bez kompilacji)

Dwie możliwe implementacje, wybierz w tej kolejności dostępności:

1. **OpenVDB przez Pythona** (`pyopenvdb` lub `openvdb` z vdbtool). `meshToVolume` na zupie trójkątów, potem `volumeToMesh` z adaptacyjnością.
2. **Blender headless.** `blender --background --python script.py -- input output voxel_size adaptivity`, modyfikator `REMESH` w trybie `VOXEL`.

Preferuj OpenVDB. Blender jest bardziej prawdopodobnie dostępny, ale jest zależnością ciężką i wolną w starcie.

**Dobór `voxel_size` (C4):** `voxel_size = diag / voxel_resolution`, domyślnie `voxel_resolution = 256`, ograniczone do zakresu `[diag/1024, diag/64]`. `--voxel-size` nadpisuje wprost.

Poprzednia reguła (`p01(edge_length) * 2`) była błędna: p01 długości krawędzi jest zdominowane przez slivery, czyli dokładnie te artefakty, które usuwamy, więc w praktyce zawsze działał dolny clamp i parametr nie był sterowany geometrią.

Ostrzeżenie do zapisania w raporcie: ten backend **niszczy ostre krawędzie**. Jeśli rozkład kątów dwuściennych wskazuje na geometrię twardokrawędziową (istotny udział kątów bliskich 90°), dopisz `sharp_features_lost` do `warnings`.

### 7.4 `poisson` i `ftetwild` (opcjonalne)

- **`poisson`**: PyMeshLab, próbkowanie punktów z normalnymi z wejścia, potem screened Poisson (Kazhdan i Hoppe, ACM TOG 32(3), 2013). Przelicz normalne przed próbkowaniem. **Obowiązkowe przycinanie po gęstości (C6):** filtr zwraca skalar `density`; usuń wierzchołki poniżej progu (start: kwantyl 0,01 rozkładu density) przed dalszą obróbką. Bez tego rekonstrukcja ekstrapoluje powierzchnię poza obszar danych i produkuje wybrzuszenia, które łamią `out→in` w A8. Próg skalibruj na fixture `ai_like_blob` i odnotuj w `NOTES.md`.
- **`ftetwild`**: wrapper na zewnętrzną binarkę (Hu et al., ACM TOG 39(4), 2020), wyciągnięcie powierzchni z tetraedryzacji. Zaimplementuj jako ostatni, tylko jeśli pozostałe kamienie milowe są zamknięte.

### 7.5 Grubość ścianki (A9) — Shape Diameter Function

```
próbkuj K punktów na powierzchni (K = min(20000, 5 * n_faces)), sampler seedowany
dla każdego punktu:
    wypuść R = 30 promieni w stożku o kącie 30° wokół -normal
    odrzuć trafienia, których normalna trafionej ściany jest zgodna z kierunkiem promienia
    grubość(punkt) = ważona mediana odległości (waga = cos kąta od osi stożka)
min_wall_estimate = p01 rozkładu grubości
```

Pojedynczy promień wzdłuż −normal (wersja 1.0) systematycznie zawyża grubość dla ścianek zbieżnych i skośnych, bo mierzy przeciwprostokątną zamiast wysokości. Stożek z ważoną medianą to Shape Diameter Function i kosztuje ten sam rząd czasu (C5).

To jest **estymator, nie dowód**. Oznacz go w raporcie jako `approximate: true`. A9 jest nieaktywne bez `--min-wall`, a błędem dopiero z `--strict` (C3).

### 7.6 Pogrubianie powłoki (`--shell-thickness`) — nowe w 1.1

Uruchamiane tylko gdy `shell_score >= 0.5` i podano `--shell-thickness T`.

Kolejność: napraw orientację, jeśli powłoka jest orientowalna (`trimesh.repair.fix_normals`), następnie zbuduj bryłę przez offset dwustronny `±T/2` wzdłuż uśrednionych normalnych wierzchołkowych, zamykając brzeg ścianami bocznymi. Wynik przekazuj do wybranego backendu jako zwykłe wejście — to on odpowiada za ostateczną gwarancję A1–A5.

Do `warnings` dopisz `shell_thickened` z użytą wartością `T`. Raport musi jasno pokazywać, że objętość wyjścia jest artefaktem parametru, a nie własnością modelu źródłowego.

---

## 8. Postprocessing

Kolejność jest istotna i nie wolno jej zmieniać. Postprocessing biegnie **zawsze**, także na ścieżce pominięcia naprawy (C8) — na czystej siatce jest wtedy operacją tożsamościową, co jest warunkiem idempotencji.

1. Usunięcie niereferowanych wierzchołków i duplikatów. Tolerancja: `tol = max(diag * 1e-8, ulp_float32(diag))` (C9). Sam `diag * 1e-8` leży poniżej rozdzielczości float32 (dla `diag ≈ 173` ulp float32 ≈ 7,6e-6), więc po round-tripie przez STL weld mógłby po cichu nie robić nic.
2. Usunięcie ścian zdegenerowanych (pole poniżej `eps_area = (diag * 1e-6)**2`).
3. Decymacja quadric edge collapse do `--target-faces`, z zachowaniem granicy topologicznej i włączonym sprawdzaniem jakości. **Pomijana, gdy `n_faces <= target_faces`** (C8). Po decymacji **powtórz pełną walidację**, bo decymacja potrafi wprowadzić samoprzecięcia.
4. Jeśli decymacja złamała kryterium twarde, cofnij ją, dopisz `decimation_reverted` do `warnings` i **wypisz to w podsumowaniu na stdout**, nie tylko do JSON (C10), razem z faktycznie zwróconą liczbą ścian.

Punkt 4 jest wymagany. Nie wolno oddawać niepoprawnej siatki tylko dlatego, że użytkownik poprosił o mniejszą liczbę trójkątów. Ponieważ A5 jest twarde, a decymacja quadric notorycznie wprowadza samoprzecięcia, cofnięcie będzie występowało często i musi być widoczne.

---

## 9. Format raportu

`report.json`, stabilny schemat, wersjonowany polem `schema_version`.

```json
{
  "schema_version": "1.1",
  "tool_version": "0.1.0",
  "timestamp_utc": "2026-07-28T10:00:00Z",
  "input": {"path": "...", "sha256": "...", "diagnosis": { ... }},
  "output": {"path": "...", "sha256": "...", "diagnosis": { ... }},
  "accepted": true,
  "criteria": {
    "A1_watertight": {"passed": true, "value": true},
    "A8_hausdorff": {"passed": true, "value": 0.44, "threshold": 0.42,
                     "unit": "model", "direction": "two_sided"},
    "A9_min_wall": {"active": false, "reason": "--min-wall not supplied"},
    "A10_is_solid": {"passed": true, "value": 0.07}
  },
  "backend": {
    "selected": "alphawrap",
    "attempts": [
      {"name": "alphawrap", "params": {"alpha": 1.2, "offset": 0.04},
       "wall_time_s": 18.4, "passed": true,
       "hausdorff_in_to_out": 0.44, "hausdorff_out_to_in": 0.31, "n_faces": 51234}
    ]
  },
  "metrics": {
    "hausdorff_out_to_in": 0.31,
    "hausdorff_in_to_out": 0.44,
    "hausdorff_two_sided": 0.44,
    "hausdorff_approximate": true,
    "chamfer": 0.08,
    "volume_ratio": 1.012,
    "face_count_ratio": 0.63,
    "min_wall_estimate": 1.1,
    "min_wall_approximate": true
  },
  "warnings": ["sharp_features_lost"]
}
```

Podsumowanie tekstowe na stdout ma się mieścić w 20 liniach, wypisywać wszystkie `warnings` (w tym `decimation_reverted` i `alphawrap_unavailable`) i zawsze kończyć jednoznacznym `ACCEPTED` albo `REJECTED: <lista naruszonych kryteriów>`.

---

## 10. Testy

### 10.1 Fixtures (generowane proceduralnie, nie commitowane jako binaria)

`tests/fixtures/generate.py` ma budować deterministycznie:

| Nazwa | Opis | Oczekiwanie |
|---|---|---|
| `clean_cube` | poprawna kostka | verdict printable, pipeline pomija naprawę |
| `open_cube` | kostka bez jednej ściany | naprawialny, A1 przechodzi po naprawie |
| `nonmanifold_edge` | trzy ściany na jednej krawędzi | A2 przechodzi po naprawie |
| `bowtie_vertex` | dwa stożki stykające się jednym wierzchołkiem | wykryte przez test wierzchołków non-manifold (§5.2), A2 przechodzi po naprawie |
| `selfintersect_torus` | dwa przenikające się torusy | A5 przechodzi, jedna składowa |
| `flipped_normals` | odwrócone 30% ścian (deterministycznie, seed) | A3 przechodzi |
| `degenerate_slivers` | dodane trójkąty o zerowym polu | A6 przechodzi |
| `two_components` | dwie rozłączne kule | `--expected-components 2` przechodzi, domyślne 1 odrzuca |
| `open_shell` | pojedynczy zakrzywiony płat bez grubości | `shell_score >= 0.5`, odmowa bez `--shell-thickness`, sukces z nią |
| `thin_shell` | zamknięta powłoka o grubości 0.2 | A9 nieaktywne bez `--min-wall`; z `--min-wall 0.8 --units mm --strict` odrzuca |
| `ai_like_blob` | sfera z szumem, dziurami i przenikaniami | verdict severe, wymusza alphawrap |

### 10.2 Testy właściwości

- **Idempotencja**: `meshfix(meshfix(x)) == meshfix(x)` na poziomie sha256 wyjścia, dla wywołania bez `--target-faces` **oraz** z `--target-faces` (drugi przebieg musi pominąć decymację zgodnie z §8.3).
- **Determinizm**: dwa uruchomienia z tymi samymi argumentami dają identyczny sha256 (w obrębie tego samego builda, §1.1).
- **Monotoniczność alfy**: dla malejącej alfy `hausdorff_in_to_out` nie rośnie, a liczba ścian nie maleje. Tolerancja na szum numeryczny 5%. Ten test ma sens wyłącznie dla kierunku `in→out`; dla `out→in` byłby szumem i flakowałby.
- **Zawieranie**: wyjście alphawrap ściśle zawiera wejście, czyli objętość wyjścia >= objętość wejścia, gdy wejście ma dobrze zdefiniowaną objętość.
- **Brak cichej porażki**: dla każdego fixture z celowo nieosiągalnym `--max-deviation 0` i `--strict` kod wyjścia wynosi 1 i raport zawiera `accepted: false`.
- **A10 nie jest obchodzone**: `open_shell` bez `--shell-thickness` kończy kodem 1 i nie zapisuje pliku wyjściowego.

### 10.3 Pokrycie

Minimum 85% na `validate.py`, `metrics.py`, `diagnose.py`. Na wrapperach backendów pokrycie liczy się tylko dla logiki parsowania i doboru parametrów, nie dla samego wywołania podprocesu.

---

## 11. Kolejność implementacji (kamienie milowe)

| M | Zakres | Kryterium zamknięcia |
|---|---|---|
| M0 | Szkielet pakietu, `io.py`, generator fixtures | wszystkie fixtures generują się i wczytują |
| M1 | `diagnose.py` (w tym `shell_score`) + `validate.py` + raport JSON + `--dry-run` | testy diagnostyki przechodzą na wszystkich fixtures; progi `severe` i `shell` skalibrowane i odnotowane |
| M2 | `metrics.py` (Hausdorff dwustronny, Chamfer, objętość) | testy monotoniczności metryk na kontrolowanych deformacjach |
| M3 | Backend `voxel` + orkiestracja + pełne CLI + `--shell-thickness` | pipeline end-to-end działa bez kompilacji C++ |
| M4 | `cpp/aw3_cli.cpp` + backend `alphawrap` + drabinka alfy | `ai_like_blob` przechodzi A1 do A7 |
| M5 | `postprocess.py` z decymacją i cofaniem | test decymacji łamiącej A5 poprawnie cofa |
| M6 | Backend `poisson` z przycinaniem po gęstości, estymator SDF | opcjonalne |

**Nie zaczynaj M4 przed zamknięciem M3.** Backend voxel jest gorszy jakościowo, ale daje działającą pętlę end-to-end, na której wszystko inne można testować.

---

## 12. Zależności

Twarde: `trimesh`, `numpy`, `scipy`, `rtree` lub `embreex` (przyspieszenie ray castingu), `typer`, `pytest`.

Miękkie, wykrywane w runtime: `pymeshlab`, `pyopenvdb`, binarka `blender`, binarka `aw3`, binarka `FloatTetwild_bin`.

Przypnij wersje w `pyproject.toml`. PyMeshLab łamie kompatybilność nazw filtrów między wydaniami, więc zakres wersji ma być wąski i jawny. **PyMeshLab przeniesiony do zależności miękkich** względem 1.0: jest potrzebny wyłącznie backendowi `poisson` (M6) i opcjonalnej implementacji testu samoprzecięć, więc rdzeń nie może się od niego uzależniać.

### 12.1 Determinizm losowości

Każda funkcja próbkująca przyjmuje `rng: numpy.random.Generator` skonstruowany z `--seed`. Zakazane jest użycie `numpy.random.*` na poziomie modułu i `random` z biblioteki standardowej w ścieżkach wpływających na wynik.

---

## 13. Decyzje pozostawione implementującemu

Rozstrzygnij i **udokumentuj w `NOTES.md`**, nie pytaj:

1. Czy własna implementacja testu samoprzecięć na AABB, czy delegacja do PyMeshLab. Kryterium: czas na `ai_like_blob` przy 500k trójkątów poniżej 30 sekund. Uwaga: PyMeshLab jest zależnością miękką (§12), więc rdzeń musi mieć działającą ścieżkę bez niego.
2. Czy Hausdorff liczyć przez PyMeshLab, czy przez próbkowanie plus `scipy.spatial.cKDTree`. Drugie jest szybsze i wystarczające, ale to estymator, więc musi być oznaczony `hausdorff_approximate: true` w raporcie.
3. Progi w regułach `severe` (§5.1) i `shell` (§5.3) są wstępne. Skalibruj je na fixtures i zaktualizuj tę specyfikację.

---

## 16. Usługa lokalna: backend naprawczy dla Steppera (nowe w 1.2)

Stepper (`przemeknowak781/stepper`) to statyczna aplikacja przeglądarkowa konwertująca siatki na STEP. Jej ścieżka „faithful" wymaga czystego, zamkniętego 2-manifoldu — a to jest dokładnie to, co gwarantuje `meshfix`. Stąd integracja: `meshfix` działa jako **opcjonalna usługa lokalna**, z której Stepper korzysta, jeśli jest uruchomiona.

Podział ról jest ostry i nie wolno go zacierać: `meshfix` odpowiada za **topologię** (A1–A10), Stepper za **konwersję do B-repu i STEP**. `meshfix` nie wie nic o STEP, Stepper nie implementuje naprawy.

### 16.1 Uruchomienie

```
meshfix serve [--port 8787] [--serve-app DIR] [--allow-origin ORIGIN]
```

`--serve-app DIR` serwuje zbudowaną aplikację Steppera z tego samego origin co API (patrz 16.4).

### 16.2 API

Trzy endpointy, ciało żądania to surowe bajty STL, parametry w query stringu.

| Metoda | Ścieżka | Znaczenie |
|---|---|---|
| `GET` | `/api/health` | `{service, version, backends: {name: {available, reason}}, max_upload_bytes}` |
| `POST` | `/api/diagnose` | pełna diagnoza + kryteria; **nie zwraca siatki** i niczego nie modyfikuje |
| `POST` | `/api/repair` | naprawa; zwraca `{report, stl_base64, refused?}` |

Parametry `/api/repair`: `voxel_resolution`, `voxel_size`, `seal`, `shell_thickness`, `expected_components`, `max_deviation`, `strict`, `seed`, `backend`.

Odpowiedź niesie **cały raport z §9**, więc przeglądarka pokazuje te same kryteria A1–A10 i te same ostrzeżenia co CLI. `stl_base64` jest `null`, gdy usługa odmówiła — wtedy `refused` niesie powód (np. otwarta powłoka bez `--shell-thickness`). Odmowa nigdy nie jest kodowana jako pusta siatka.

### 16.3 Bezpieczeństwo

Usługa otwiera port na maszynie użytkownika, więc:

- **Gniazdo wiąże się wyłącznie z `127.0.0.1`**, nigdy `0.0.0.0`. Usługa jest nieosiągalna z sieci.
- Origin żądań cross-origin jest sprawdzany wobec jawnej listy dozwolonych. Strona spoza listy nie dostaje nagłówków CORS i przeglądarka ją blokuje.
- `POST` wymaga `Content-Type: application/octet-stream`, co **wymusza preflight**. Wroga strona nie doprowadzi więc nawet do wykonania żądania bez przejścia kontroli origin.

### 16.4 Mixed content — jedyna pułapka wdrożeniowa

Strona serwowana po **https** może wołać `http://localhost` tylko dlatego, że localhost liczy się jako *potentially trustworthy origin*. Chromium to honoruje; Firefox i Safari historycznie blokowały. Dlatego:

- **Zalecane:** `meshfix serve --serve-app dist` — aplikacja i API pod jednym originem, problem znika we wszystkich przeglądarkach.
- Działa też Stepper z `pnpm dev` (`http://localhost:5173`), bo to już http.
- Stepper z GitHub Pages (https) zadziała w Chromium, a w pozostałych przeglądarkach wykrywanie po prostu zwróci „usługa niedostępna".

Klient (`src/lib/meshfix/client.ts`) traktuje brak usługi, blokadę mixed content i timeout **identycznie**: `detect()` zwraca `null` i aplikacja działa dalej na ścieżce przeglądarkowej. Nie wolno tego rozróżniać komunikatem sugerującym awarię — dla użytkownika bez usługi to stan normalny.

### 16.5 Miejsce w potoku

```
plik → [meshfix, jeśli dostępny] → czysty manifold → planarizeMesh → STEP
                ↓ niedostępny
        repairMesh/solidify w przeglądarce → planarizeMesh → STEP
```

Obie ścieżki kończą się tą samą planaryzacją, więc wynikowy STEP ma ten sam format; różni się wyłącznie jakość gwarancji topologicznej wejścia do niej.

---

## 14. Źródła

- Portaneri, Hemmer, Rineau, Alliez, *Alpha Wrapping with an Offset*, ACM TOG 41(4), SIGGRAPH 2022. Dokumentacja pakietu: https://doc.cgal.org/latest/Alpha_wrap_3/
- Hu, Schneider, Wang, Zorin, Panozzo, *Fast Tetrahedral Meshing in the Wild*, ACM TOG 39(4), 2020, doi:10.1145/3386569.3392385
- Kazhdan, Hoppe, *Screened Poisson Surface Reconstruction*, ACM TOG 32(3), 2013, doi:10.1145/2487228.2487237
- Shapira, Shamir, Cohen-Or, *Consistent mesh partitioning and skeletonisation using the shape diameter function*, The Visual Computer 24(4), 2008 (podstawa §7.5)
- Attene, *A lightweight approach to repairing digitized polygon meshes*, The Visual Computer 26(11), 2010 (MeshFix, kontekst historyczny)
- Muntoni, Cignoni, *PyMeshLab*, doi:10.5281/zenodo.4438750
- Huang, Zhou, Guibas, *ManifoldPlus: A Robust and Scalable Watertight Manifold Surface Generation Method for Triangle Soups*, arXiv:2005.11621

---

## 15. Antywzorce, których agent ma unikać

- `try: ... except Exception: pass` wokół wywołań geometrycznych. Każdy wyjątek ma być zalogowany z kontekstem.
- Raportowanie sukcesu na podstawie tego, że backend zakończył się kodem 0. Kryterium sukcesu jest walidacja siatki, nie kod wyjścia podprocesu.
- Mieszanie pojęć „broken faces", „non-manifold" i „self-intersection". To trzy różne rzeczy i raport ma je rozróżniać.
- Mutowanie siatki wejściowej w miejscu w `diagnose.py`.
- Gatowanie wierności na jednym kierunku Hausdorffa. Utrata detalu i napompowanie to dwa różne tryby awarii i wymagają dwóch różnych pomiarów.
- Milczące pogrubianie otwartej powłoki do bryły o grubości wynikającej z parametru regularyzacji backendu.
- Dodawanie zależności spoza sekcji 12 bez odnotowania w `NOTES.md`.
- Tworzenie warstwy LLM, agenta, promptów albo „inteligentnego" doboru parametrów opartego na modelu językowym. Narzędzie jest deterministyczne z założenia.
