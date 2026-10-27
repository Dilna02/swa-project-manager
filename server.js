// Local and Render/Railway entry point. Vercel uses api/[...path].js instead.
const app = require("./lib/app");
const PORT = +process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SWA Project Manager running on http://localhost:${PORT}`));
