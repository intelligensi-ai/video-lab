import { app } from './index.js';

const port = Number(process.env.PORT ?? 5001);

app.listen(port, () => console.log(`api listening on ${port}`));
