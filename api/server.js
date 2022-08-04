'use strict';

const Redis = require('ioredis');
const express = require('express');
const { Pool, Client } = require("pg");
const cors = require('cors');

// Constants
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';


  const credentials = {
    user: process.env.PG_USER || "postgres",
    host: process.env.PG_HOST || "localhost",
    database: process.env.PG_DATABASE || "nodedemo",
    password: process.env.PG_PASSWORD || "yourpassword",
    port: process.env.PG_PORT || 5432,
  };
  console.log(credentials)

  if (process.env.REDIS_HOST === "localhost"){
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const redis = new Redis({
    port: process.env.REDIS_PORT,
    host: process.env.REDIS_HOST,
    tls: {}
  });

// App
const app = express();
app.use(cors());

app.get('/',  (req, res) => {
  res.send({"message": `I am the api running on port ${process.env.PORT}`});
});


app.get('/redis/put/:key/:value', async (req, res) => {
  await redis.set(req.params.key, req.params.value);
  res.send({"message": `I wrote ${req.params.key}:${req.params.value} for you`});
});
app.get('/redis/get/:key', async (req, res) => {
  const value = await redis.get(req.params.key);
  res.send({"message": `I grabbed ${req.params.key}:${value} for you`});
});


app.get('/pg/init', async (req, res) => {
  console.log('Init pg');
  const pgClient = new Client(credentials);
  console.log('client init')
  await pgClient.connect();
  console.log('client connected')
  const result = await pgClient.query(`create table if not exists items (key text, value text)`);
  console.log(result);
  res.send({"message": `I initialized the table items for you.`});
});

app.get('/pg/put/:key/:value', async (req, res) => {
  console.log('put pg')
  const pgClient = new Client(credentials);
  console.log('client init')
  await pgClient.connect();
  console.log('client connected')
  const result = await pgClient.query(`insert into items (key,value) VALUES ('${req.params.key}', '${req.params.value}')`);
  console.log(result);
  res.send({"message": `I wrote ${req.params.key}:${req.params.value} for you`});
});

app.get('/pg/get/:key/', async (req, res) => {
  console.log('get pg')
  const pgClient = new Client(credentials);
  console.log('client init')
  await pgClient.connect();
  console.log('client connected')
  const result = await pgClient.query(`select * from items where key = '${req.params.key}'`);
  console.log(result);
  let value;
  try {
    value = result.rows[0].value;
    res.send({"message": `I grabbed ${req.params.key}:${value} for you`});
  }
  catch (err){
    res.send({"message": `I couldn't find ${req.params.key} in my database, beep boop bop.`});
  }
  
});

app.listen(PORT, HOST);
console.log(`Running on http://${HOST}:${PORT}`);
