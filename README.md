# AD Portal (Node.js)

Modularny portal do zarządzania AD pod środowisko szpitalne:

- logowanie po poświadczeniach AD,
- autoryzacja po konkretnych użytkownikach lub grupie AD,
- wyszukiwarka obiektów (użytkownicy/komputery/grupy),
- osobne modale dla różnych typów obiektów,
- zarządzanie `memberOf` (dodawanie grup, kopiowanie zaznaczonych grup od użytkownika referencyjnego),
- zarządzanie członkami grupy (dodawanie/usuwanie kont bezpośrednio z poziomu obiektu grupy),
- przenoszenie obiektu do OU,
- kreator nowego użytkownika,
- podgląd i eksport (PDF / schowek) kluczy odzyskiwania BitLocker dla komputerów,
- odblokowywanie kont przeniesionych do OU zablokowane_konta (z wyborem docelowego OU),
- zakładka raportów (np. logowania starsze niż X lat),
- szczegółowe logi zmian (kto, co i jakie wartości zmienił),
- ustawienia portalu: domyślna grupa dla nowych kont, kategorie uprawnień (zestawy grup do szybkiego zastosowania),
- integracja z SCCM (wyszukiwanie/podgląd urządzeń, kolumna "Komputer" przy użytkownikach) – patrz sekcja SCCM poniżej,
- toasty i modale w UI,
- **działanie offline UI** z pełnym Bootstrapem dostarczonym lokalnie z `node_modules/bootstrap/dist` (bez CDN).

## Uruchomienie

1. Skopiuj konfigurację:

```bash
cp .env.example .env
```

2. Uzupełnij dane AD w `.env`.
3. Zainstaluj zależności i uruchom:

```bash
npm install
npm run dev
```

## Architektura modułowa

- `src/services/ad/*` – integracja i operacje AD,
- `src/services/reports/*` – raporty,
- `src/routes/*` – warstwa API i widoki,
- `src/middleware/*` – middleware (np. auth),
- `src/views/*` i `src/public/*` – UI (EJS + JS aplikacyjny),
- `/bootstrap/*` – statyczny mount do `node_modules/bootstrap/dist` (offline, lokalne pliki).

## Ważne dla AD

- Do ustawiania haseł i modyfikacji kont używaj `LDAPS`.
- Konto serwisowe powinno mieć tylko minimalne wymagane uprawnienia.
- W produkcji ustaw `AD_TLS_REJECT_UNAUTHORIZED=true` i poprawny certyfikat CA.

## LDAP / LDAPS i TLS

Możesz teraz skonfigurować połączenie na dwa sposoby:

1. **Pełny URL** przez `AD_URL` (np. `ldap://dc01.hospital.local:389` albo `ldaps://dc01.hospital.local:636`).
2. **Składany URL** przez:
   - `AD_PROTOCOL=ldap` lub `AD_PROTOCOL=ldaps`,
   - `AD_HOST`,
   - `AD_PORT`.

Dodatkowo:

- `AD_TLS_ENABLED=true|false` – włącza/wyłącza TLS.
  - Dla `ldap://` działa jako **StartTLS**.
  - Dla `ldaps://` szyfrowanie jest zapewniane przez sam protokół.
- `AD_TLS_REJECT_UNAUTHORIZED=true|false` – walidacja certyfikatu TLS.
- `AD_USE_LOGGED_USER_BIND=true|false` – wybór kontekstu uprawnień dla operacji AD:
  - `false` (domyślnie): operacje wykonywane kontem serwisowym (`AD_BIND_DN`),
  - `true`: operacje wykonywane poświadczeniami aktualnie zalogowanego użytkownika.

## SCCM (Microsoft Configuration Manager)

Portal łączy się z **AdminService** Twojej witryny SCCM (REST/OData, dostępny od wersji 1802+, pod
`https://<serwer>/AdminService/wmi`). Uwierzytelnianie to **NTLM (Windows Integrated)**, tym samym
kontem AD co LDAP – ale NTLM wymaga zwykłej nazwy użytkownika i domeny, a nie DN/UPN, dlatego:

- gdy `AD_USE_LOGGED_USER_BIND=true` – używane są login i hasło aktualnie zalogowanego użytkownika
  portalu (login jest już w formacie `sAMAccountName`, więc nic dodatkowego nie trzeba ustawiać),
- gdy `AD_USE_LOGGED_USER_BIND=false` – ustaw `SCCM_SERVICE_USERNAME` na `sAMAccountName` konta
  serwisowego z `AD_BIND_DN` (hasło to nadal `AD_BIND_PASSWORD` – to to samo konto).

Zmienne środowiskowe:

- `SCCM_URL` – bazowy URL AdminService, np. `https://sccm01.hospital.local/AdminService/wmi`.
- `SCCM_DOMAIN` – domena NTLM (NetBIOS lub DNS); domyślnie wyliczana z `AD_BASE_DN`. Jeśli
  uwierzytelnianie się nie powiedzie, spróbuj ustawić krótką nazwę NetBIOS Twojej domeny.
- `SCCM_SERVICE_USERNAME` – patrz wyżej.
- `SCCM_TLS_REJECT_UNAUTHORIZED` – walidacja certyfikatu TLS AdminService (domyślnie `true`).

**Zakres obecnej integracji (pierwszy etap):** wyszukiwanie/lista urządzeń, podgląd szczegółów
(dane z `SMS_R_System`, data ostatniego skanu sprzętowego z `SMS_G_System_WORKSTATION_STATUS`),
link „Pokaż w SCCM" z głównej wyszukiwarki oraz kolumna „Komputer" przy użytkownikach (na
podstawie `SMS_UserMachineRelationship`). Kolekcje, wdrożenia i status aktualizacji są
planowane w kolejnym etapie.

**Uwaga:** ta integracja nie mogła zostać przetestowana na prawdziwej witrynie SCCM (brak
dostępu do serwera w środowisku, w którym powstał ten kod). Nazwy klas WMI/OData i sposób
uwierzytelniania odpowiadają standardowej, domyślnej konfiguracji AdminService, ale jeśli Twoja
witryna różni się (np. niestandardowe klasy inwentaryzacji, inny format domeny NTLM), może być
potrzebna korekta w `src/services/sccm/sccmClient.js`.

### Rozwiązywanie problemów

- **„Couldn't find NTLM in the message type2 coming from the server"** – portal przy błędzie
  połączenia automatycznie odpytuje serwer SCCM bez logowania, żeby sprawdzić, jakie
  uwierzytelnianie faktycznie oferuje, i dopisuje to do komunikatu błędu. Najczęstsza przyczyna:
  w IIS dla AdminService włączone jest tylko „Negotiate" (Kerberos), a nie dostawca „NTLM" w
  Windows Authentication – ten portal obsługuje wyłącznie NTLM. Włącz dostawcę NTLM w IIS, albo,
  jeśli NTLM jest w organizacji celowo zablokowany politykami GPO, integracja w obecnej postaci
  nie zadziała i wymagałaby wsparcia dla Kerberos zamiast NTLM (większa zmiana, do uzgodnienia).
- **„SCCM AdminService odrzucił uwierzytelnianie (401/403)"** – konto się negocjuje, ale zostaje
  odrzucone: sprawdź `SCCM_SERVICE_USERNAME`/hasło (czy to na pewno `sAMAccountName`, nie DN) i
  czy to konto ma uprawnienia do odczytu w SCCM (rola „Read-only Analyst" lub wyższa).
- **Błąd wskazuje na kod inny niż 401** – prawdopodobnie `SCCM_URL` nie wskazuje bezpośrednio na
  AdminService (np. trafia na stronę logowania albo przekierowanie) – zweryfikuj URL w
  przeglądarce: `https://<serwer>/AdminService/wmi/SMS_R_System` powinno poprosić o
  uwierzytelnienie Windows, a nie zwracać stronę HTML.
