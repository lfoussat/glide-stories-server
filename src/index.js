require('dotenv').config()
const express = require('express')
const db = require('./db-knex.js')
const got = require('got')
const auth = require('./auth/local.js')
const aws = require('aws-sdk')
const multer = require('multer')
const multerS3 = require('multer-s3')
const metascraper = require('metascraper')
const Twitter = require('twitter-node-client').Twitter
const bodyParser = require('body-parser')
const path = require('path')
const app = express()

const twitter = new Twitter({
  consumerKey: process.env.TWITTER_CONSUMER_KEY,
  consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessTokenSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET
})

aws.config.update({
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  region: process.env.AWS_REGION || 'eu-west-3'
})

const s3 = new aws.S3()

app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())
app.use(auth.tokenParser)

const getTweet = id => new Promise((resolve, reject) => {
  twitter.getTweet({ id }, reject, resolve)
})

const awaitRoute = routeHandler => async (req, res, next) => {
  try {
    const result = await routeHandler(req, res)
    if (result !== undefined) {
      res.json(result)
    }
  } catch (err) {
    next(err)
  }
}

const clientOrigin = process.env.CLIENT_ORIGIN
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', clientOrigin)
  res.header('Access-Control-Allow-Methods', '*')
  res.header('Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, X-Access-Token')
  next()
})

const upload = multer({
  storage: multerS3({
    s3,
    acl: 'public-read',
    bucket: process.env.AWS_BUCKET_NAME,
    key: (req, file, cb) => cb(null, file.originalname)
  }),
  fileFilter: (req, file, cb) => { // accepts only images
    const ext = path.extname(file.originalname).toLowerCase()
    if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg' && ext !== '.gif') {
      req.fileValidationError = 'invalid file type'
      return cb(new Error('invalid file type'), false)
    }
    cb(null, true)
  },
  limits: { // limited at 5 Mo
    fileSize: 5000000
  }
}).array('image', 1)

const slideHandlers = {
  intro: {
    create: ({ glideId }) => ({
      title: '',
      subtitle: '',
      image_url: '',
      glide_id: glideId
    }),
    update: ({ title, subtitle }) => ({ title, subtitle })
  },

  text: {
    create: ({ glideId }) => ({
      text: '',
      glide_id: glideId
    }),
    update: ({ text }) => ({ text })
  },

  image: {
    create: ({ glideId }) => ({
      text: '',
      image_url: '',
      glide_id: glideId
    }),
    update: ({ text }) => ({ text })
  },

  tweet: {
    create: async ({ glideId, url }) => {
      const tweetId = url.split('/').slice(-1).join('')
      const tweet = JSON.parse(await getTweet(tweetId))

      const newTweet = {
        publication_date: tweet.created_at,
        tweet_url: url,
        image_url: tweet.user.profile_image_url_https,
        author_name: tweet.user.name,
        author_screen_name: tweet.user.screen_name,
        text: tweet.text,
        glide_id: glideId
      }

      if (!newTweet.image_url && !newTweet.author_name && !newTweet.author_screen_name && !newTweet.publication_date && !newTweet.text) {
        return undefined
      } return newTweet
    },
    update: async (slide) => {
      const tweetId = slide.tweetUrl.split('/').slice(-1).join('')
      const tweet = JSON.parse(await getTweet(tweetId))

      return ({
        publication_date: tweet.created_at,
        tweet_url: slide.tweetUrl,
        image_url: tweet.user.profile_image_url_https,
        author_name: tweet.user.name,
        author_screen_name: tweet.user.screen_name,
        text: tweet.text
      })
    }
  },

  article: {
    create: async ({ glideId, url }) => {
      const { body } = await got(url)
      const metadatas = await metascraper({ html: body, url })

      return ({
        article_url: metadatas.url,
        author_name: metadatas.author,
        source_name: metadatas.publisher,
        source_image: metadatas.logo,
        text: '',
        glide_id: glideId
      })
    },
    update: async slide => {
      const articleUrlDB = await db.getArticleUrlBySlideId(slide.id)

      if (slide.articleUrl !== articleUrlDB.article_url) {
        const { body } = await got(slide.articleUrl)
          .catch(err => {
            console.error('wrong url', err.message)
            throw Error('wrong url')
          })

        const metadatas = await metascraper({ html: body, url: slide.articleUrl })
          .catch(err => {
            console.error('unable to parse meta', err.message)
            throw Error('unable to parse meta')
          })

        return ({
          article_url: metadatas.url,
          author_name: metadatas.author,
          source_name: metadatas.publisher,
          source_image: metadatas.logo,
          text: ''
        })
      }
      return ({
        author_name: slide.authorName,
        publication_date: slide.publicationDate,
        source_name: slide.sourceName,
        source_image: slide.sourceImage,
        text: slide.text
      })
    }
  },

  callToAction: {
    create: ({ glideId }) => ({
      title: '',
      subtitle: '',
      image_url: '',
      btn_text: '',
      btn_link: '',
      glide_id: glideId
    }),
    update: slide => ({
      title: slide.title,
      subtitle: slide.subtitle,
      image_url: slide.imageUrl,
      btn_text: slide.btnText,
      btn_link: slide.btnLink
    })
  }
}

app.post('/slide/:type/:id', auth.requireToken, (req, res) => {
  upload(req, res, (err) => {
    if (err) {
      console.log('there is an error', err)
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.json({ error: 'File too big' })
      }
      if (req.fileValidationError) {
        return res.json({ error: 'Invalid type file' })
      }
    }

    console.log(req.files)

    const [ { location } ] = req.files
    db.setSlideImage({
      type: req.params.type,
      id: req.params.id,
      image: location
    }).then(() => res.json({ url: location }))
  })
})

app.post('/slides', auth.requireToken, awaitRoute(async req => {
  const slide = req.body
  const params = await slideHandlers[slide.type].create(slide)
  const [ id ] = await db.createSlide(slide, params)
  return { id, ...db.camelSnake(params) }
}))

app.post('/slides/:id', auth.requireToken, awaitRoute(async req => {
  const slide = { ...req.params, ...req.body }
  const tweetRegex = RegExp('(https?:\/\/)(twitter.com)\/([a-zA-Z0-9_]*)\/(status)\/([0-9]*)') // eslint-disable-line
  if ((slide.type === 'tweet') && (!tweetRegex.test(slide.tweetUrl))) return { id: slide.id } // return { error: 'Wrong tweet url format type' } ??
  const params = await slideHandlers[slide.type].update(slide)

  await db.updateSlide(slide, params)
    .catch(err => {
      console.error('Unabled to save data in database. Try again later.', err.message)
      throw Error('Unabled to save data in database. Try again later.')
      // Promise.reject(Error('Unabled to save data in database. Try again later.'))
    })

  if (slide.type === 'tweet') {
    return { id: slide.id, ...db.camelSnake(params) }
  } else if (slide.type === 'article') {
    return { id: slide.id, articleLink: slide.articleUrl, ...db.camelSnake(params) }
  }
  return { id: slide.id }
}))

app.delete('/slides/:type/:id', auth.requireToken, awaitRoute(async (req) => {
  const { id, type } = req.params
  await db.deleteSlide(type, id)

  return 'deleted'
}))

app.get('/glides', auth.requireToken, awaitRoute(req => db.getGlides(req.token.id)))
app.get('/glides/:id', awaitRoute(req => db.getGlide(req.params.id)))
app.get('/getUserEmail', auth.requireToken, (req, res) => res.json(req.token.email))
app.post('/glides', auth.requireToken, awaitRoute(async req => db.createGlide({ title: req.body.title, userId: req.token.id })))
app.post('/glides/:id', auth.requireToken, awaitRoute(req => db.updateGlideOrder({
  ...req.params,
  ...req.body
})))

app.delete('/glides/:id', auth.requireToken, awaitRoute(async (req) => {
  const id = Number(req.params.id)
  await db.deleteGlide(id)

  return 'deleted'
}))

app.post('/users', awaitRoute(auth.createUser))
app.post('/auth/local', awaitRoute(auth.login))
app.use((err, req, res, next) => {
  if (err) {
    res.status(500).json({ error: err.message })
  } else {
    res.status(404).json({ error: 'Not Found' })
  }
})

app.listen(process.env.PORT, () => console.log(`Port ${process.env.PORT}`))
