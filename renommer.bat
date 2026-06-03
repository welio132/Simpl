@echo off
echo Renommage des fichiers Simpl...

:: Trouve et renomme index
for %%f in (index*.html) do if not "%%f"=="index.html" ren "%%f" "index.html"

:: Trouve et renomme creer
for %%f in (creer*.html) do if not "%%f"=="creer.html" ren "%%f" "creer.html"

:: Trouve et renomme dashboard
for %%f in (dashboard*.html) do if not "%%f"=="dashboard.html" ren "%%f" "dashboard.html"

:: Trouve et renomme store
for %%f in (store*.html) do if not "%%f"=="store.html" ren "%%f" "store.html"

:: Trouve et renomme admin
for %%f in (admin*.html) do if not "%%f"=="admin.html" ren "%%f" "admin.html"

:: Trouve et renomme server
for %%f in (server*.js) do if not "%%f"=="server.js" ren "%%f" "server.js"

echo Fait ! Tous les fichiers sont renommes.
pause
