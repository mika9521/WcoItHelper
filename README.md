# AD Portal (Node.js)

Modularny portal do zarządzania AD pod środowisko szpitalne:

- logowanie po poświadczeniach AD,
- autoryzacja po konkretnych użytkownikach lub grupie AD,
- wyszukiwarka obiektów (użytkownicy/komputery/grupy),
- osobne modale dla różnych typów obiektów,
- zarządzanie `memberOf` (dodawanie grup, kopiowanie zaznaczonych grup od użytkownika referencyjnego),
- przenoszenie obiektu do OU,
- kreator nowego użytkownika,
- zakładka raportów (np. logowania starsze niż X lat),
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
