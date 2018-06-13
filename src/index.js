const express = require('express')
const app = express()
const sip = require('./database/mock.json')
const config = require('./data/twitter_config.js')

const Twitter = require('twitter-node-client').Twitter
const twitter = new Twitter(config)

const getTweet = id => new Promise((resolve, reject) => {
  twitter.getTweet({ id }, reject, resolve)
})

getTweet('1006522254727892992')
  .then(console.log)
  .catch(console.error)

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin)
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  next()
})

app.get('/', (req, res) => {
  res.json('Hello World')
})

app.get('/mock', (req, res) => {
  res.json(sip)
})

app.listen(5000, () => console.log('Port 5000'))
