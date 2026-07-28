import express from 'express';
export const app = express();
app.use(cors({origin: true, credentials: true}));