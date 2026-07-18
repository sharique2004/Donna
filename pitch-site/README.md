# Donna pitch — standalone host

Serves the pitch deck at https://projectdonna-pitch.vercel.app.
Source of truth: ../frontend/public/pitch-deck.html — copy it over index.html (keep the header comment) and run:

    npx vercel@latest deploy --prod --archive=tgz
