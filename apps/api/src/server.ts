import { app } from './index.js';
import { boundedInteger } from '@video-lab/runtime-adapter';

const port = boundedInteger(process.env.PORT, 5001, 1, 65_535);

app.listen(port, () => console.log(`api listening on ${port}`));
