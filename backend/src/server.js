import { createApp } from './app.js';

const port = Number(process.env.PORT || 8080);
const { app } = createApp();
app.listen(port, () => {
  console.log(`Swaapo API on http://localhost:${port}/api  ·  Control Center on http://localhost:${port}/admin`);
  if (!process.env.TOKEN_SECRET) console.warn('TOKEN_SECRET is not set: using a random one, so logins reset on restart.');
});
