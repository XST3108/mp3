// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');
var { ApiError, send } = require('./routes/helpers');

// Read .env file
require('dotenv').config({ quiet: true });

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Connect to a MongoDB (skipped when this file is required by a test script)
if (require.main === module) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(function () { console.log('Connected to MongoDB'); })
        .catch(function (err) { console.error('MongoDB connection error:', err.message); });
}

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

// Unknown route
app.use(function (req, res) {
    send(res, 404, 'Endpoint not found', null);
});

// Error handler: never leak Mongoose/MongoDB internals to the client
// eslint-disable-next-line no-unused-vars
app.use(function (err, req, res, next) {
    if (err instanceof ApiError) return send(res, err.status, err.message, null);
    if (err.type === 'entity.parse.failed') return send(res, 400, 'Request body is not valid JSON', null);
    if (err.code === 11000) return send(res, 400, 'A user with this email already exists', null);
    if (err.name === 'ValidationError' || err.name === 'CastError') {
        return send(res, 400, 'Request contains invalid or missing fields', null);
    }
    console.error(err);
    return send(res, 500, 'Internal server error, please try again later', null);
});

// Start the server
if (require.main === module) {
    app.listen(port);
    console.log('Server running on port ' + port);
}

module.exports = app;
