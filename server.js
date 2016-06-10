"use strict";

var express = require('express');
var app = express();
var bodyParser = require('body-parser');
// var db = require('apoc');
// db = Promise.promisifyAll(db);
var Promise = require('bluebird');
var bcrypt = require('bcrypt');
var crypto = require('crypto');
var yelp = require('./Utils/api');
var nodemailer = require('nodemailer');
var gmailKeys = require('./Utils/apiKeys').gmailKeys;
var formattedDateHtml = require('./Utils/dateFormatter');
var generateEmail = require('./Utils/emailGenerator');
var boundingBoxGenerator = require('./Utils/boundingBoxGenerator');
var roamOffGenerator = require('./Utils/roamOffGenerator');
var saltRounds = 10;

//neo4j database config
var GRAPHENEDB_URL = 'http://app52006967-YuSPiu:u3sxAz6knWZmWF2t6ZFl@app52006967yuspiu.sb05.stations.graphenedb.com:24789';
var neo4j = require('node-neo4j');

var db = new neo4j('http://neo4j:teek@127.0.0.1:7474');
db = Promise.promisifyAll(db);



//config for email SMTP for gmail. We are send email notifications to users
var smtpConfig = { 
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // use SSL
  auth: {
    user: 'roamincenterprises@gmail.com',
    pass: 'roamroam'
  }
};

//transport vehicle for nodemailer to send out email
var transporter = nodemailer.createTransport(smtpConfig); 

app.use(bodyParser.json());

//Checks to make sure server is working
app.get('/', function(req, res){
  res.send('Hello World!');
});

//Post to server on signup page
app.post('/signup', function(req, res){

  console.log('db', db);

  var data = req.body;

  console.log('data', data);

  // db.cypherQuery('MATCH (n:User {email: "{email}"}) RETURN n', {email: data.email},
  //   (err, res) => {
  //     if (err) {
  //       console.log('error!', e);
  //     } else {
  //       console.log('results: ', res);
  //     }
  //   });

  //Check database to see if incoming email on signup already exists
  db.cypherQueryAsync('MATCH (n:User {email: "{email}"}) RETURN n', { email: data.email }).then(function(queryRes) {
    //If there is no matching email in the database
    console.log('inside query');

    if (queryRes[0].data.length === 0) {
      //Hash password upon creation of account
      bcrypt.genSalt(saltRounds, function(err, salt) {
        if (err) {
          console.log('Error generating salt', err);
        }
        bcrypt.hash(req.body.password, salt, function(err, hash) {
          if (err) {
            console.log('Error hashing password', err);
          }
          data.password = hash;
          //Creates new server in database
          db.cypherQueryAsync('CREATE (newUser:User {firstName: "{firstName}", lastName: "{lastName}", password: "{password}", email: "{email}"});', data).then(
            function(dbRes){
              console.log('saved to database:', dbRes);
              res.send(JSON.stringify({message: 'User created'}));
            },
            function(fail){
              console.log('issues saving to database:', fail);
            }
          );
        });
      }); //close genssalt
    } else {
      res.send(JSON.stringify({message: 'Email already exists!'}));
    }
  })
  .catch(e => console.log('error in catch: ', e)); //closing 'then'
}); //close post request

//Validation for sign in page
app.post('/signin', function(req, res){
  var data = req.body;
  db.cypherQueryAsync('MATCH (n:User {email: "{email}"}) RETURN n.password', {email: data.email}).then(function(queryRes){
    if(queryRes[0].data.length === 0) {
      res.send(JSON.stringify({message: 'Incorrect email/password combination!'}));
    } else {
      console.log(queryRes[0].data[0].row[0]);
      bcrypt.compare(data.password, queryRes[0].data[0].row[0], function(err, bcryptRes){
       if(err){
        console.log('error in comparing password:', err);
       }
        if(bcryptRes){
          res.send(JSON.stringify({message: 'Password Match'}));
        } else {
          res.send(JSON.stringify({message: 'Incorrect email/password combination!'}));
        }
      });
    }
  });
});

//Page to set up event between users, making API calls to YELP
app.post('/roam', function(req, res) {

	var dateMS = Date.now();
  var userEmail = req.body.userEmail;
  var groupSize = req.body.groupSize;
  var Roamers = 0;
  switch (groupSize) {
    case 'Solo':
      Roamers = 2;
      break;
    case 'Group':
      Roamers = 6;
      break;
  }
  var coords = boundingBoxGenerator(req); //bounding box coordinates
  var times = roamOffGenerator(req); //time until roam ends
  console.log(Roamers, 'roamers');
  //Checks to make sure if there is an existing pending roam within similar location by a different user
  db.cypherQueryAsync('MATCH (n:Roam) WHERE n.creatorRoamEnd > {currentDate} AND n.creatorLatitude < {maxLat} AND n.creatorLatitude > {minLat} AND n.creatorLongitude < {maxLong} AND n.creatorLongitude > {minLong} AND n.creatorEmail <> "{userEmail}" AND n.numRoamers < {Roamers} AND n.maxRoamers = {Roamers} RETURN n', {currentDate:dateMS, maxLat: coords.maxLat, minLat: coords.minLat, maxLong: coords.maxLong, minLong: coords.minLong, userEmail: userEmail, Roamers: Roamers, maxRoamers: Roamers}).then(function(matchResults) {
    console.log('in first query');
    //if no match found create a pending roam node
    if (matchResults[0].data.length === 0) {
    console.log('nomatch');
      var searchParams = {
        term: 'Bars',
        limit: 20,
        sort: 0,
        radius_filter: 3200, //2-mile radius
        bounds: coords.maxLat + ',' + coords.minLong + '|' +  coords.minLat  + ',' + coords.maxLong
      };      

      //Creates the YELP object to make API request to yelp servers
      yelp.searchYelp(searchParams, function(venue) {
        
        var venueName = venue.name;
        var venueAddress = venue.location.display_address.join(' ');

        //Create a roam node if it doesn't exist
        db.cypherQueryAsync('CREATE (m:Roam {creatorEmail: "{userEmail}", creatorLatitude: {userLatitude}, creatorLongitude: {userLongitude}, creatorRoamStart: {startRoam}, creatorRoamEnd: {roamOffAfter}, numRoamers: 1, maxRoamers: {Roamers}, venueName: "{venueName}", venueAddress: "{venueAddress}"})', { Roamers: Roamers, email: userEmail, userEmail: userEmail, userLatitude: coords.userLatitude, userLongitude: coords.userLongitude,
      startRoam: times.startRoam, roamOffAfter: times.roamOffAfter, venueName: venueName, venueAddress: venueAddress }).then(function(queryRes) {

          // creates the relationship between creator of roam node and the roam node
          db.cypherQueryAsync('MATCH (n:User {email:"{email}"}), (m:Roam {creatorEmail: "{creatorEmail}", creatorRoamStart: {roamStart}) CREATE (n)-[:CREATED]->(m)', {email:userEmail, creatorEmail: userEmail, roamStart: times.startRoam} ).then(function(relationshipRes) {
             console.log('Relationship created', relationshipRes); 
          });
        });
      });
    
    res.send(JSON.stringify('No match currently'));

		} else { //Roam node found within a similar geographic location
      console.log('Found a match', matchResults[0].data[0].meta[0].id);

      var id = matchResults[0].data[0].meta[0].id;

      //Grabs roam node between similar location, and creates the relationship between node and user
      db.cypherQueryAsync('MATCH (n:User {email:"{email}"}), (m:Roam) WHERE id(m) = {id} SET m.numRoamers=m.numRoamers+1 CREATE (n)-[:CREATED]->(m) RETURN m', {email:userEmail, id:id}).then(function(roamRes) {
          console.log('Relationship created b/w Users created', roamRes[0].data[0].row[0]);
          var roamInfo = roamRes[0].data[0].row[0];

          var date = formattedDateHtml();

          //Generates an automatic email message
	        var mailOptions = {
	          from: '"Roam" <Roamincenterprises@gmail.com>', // sender address 
	          bcc: roamInfo.creatorEmail + ',' + userEmail, // List of users who are matched
	          subject: 'Your Roam is Ready!', // Subject line 
	          text: 'Your Roam is at:' + roamInfo.venueName + ' Roam Address: ' + roamInfo.venueAddress, // plaintext body 
	          html: generateEmail(roamInfo.venueName, roamInfo.venueAddress, date) // html body 
	        };
	         
	        // send mail with defined transport object 
	        transporter.sendMail(mailOptions, function(error, info){
	          if(error){
	            return console.log(error);
	          }
	          console.log('Message sent: ' + info.response);
	        });

          res.send(JSON.stringify("You have been matched!")); 
        })
        .catch(e => console.log('error: ', e));
    }
	})
  .catch(e => console.log('error', e));
});

//Cancellation of roam; only the creator has cancellation abilities
app.post('/cancel', function(req, res){
  var userEmail = req.body.userEmail;
  console.log('useremail is:', userEmail);

  //Finds roam node that user created and cancels it
  db.cypherQueryAsync('MATCH (m:Roam {creatorEmail: "{userEmail}"}) WHERE m.status="Pending" SET m.status="Canceled" RETURN m', {userEmail: userEmail}).exec().then(function(cancelRes){

  	console.log('Roam canceled:', cancelRes[0].data[0].row[0]);

    var roamInfo = cancelRes[0].data[0].row[0];

    //Sends cancellation email
    var mailOptions = {
      from: '"Roam" <Roamincenterprises@gmail.com>', // sender address 
      bcc: roamInfo.creatorEmail + ',' + userEmail,
      subject: 'Your Roam has been canceled!', // Subject line 
      text: 'Your Roam at:' + roamInfo.venueName + ' Roam Address: ' + roamInfo.venueAddress + ' has been canceled.', // plaintext body 
      html: '<div><h3>Roam Venue: <br>' + roamInfo.venueName + '</h3></div><div><h3>Roam Address: ' + roamInfo.venueAddress + ' has been canceled.</h3></div>' // html body 
    };
     
    // send mail with defined transport object 
    transporter.sendMail(mailOptions, function(error, info){
      if(error){
        return console.log(error);
      }
      console.log('Message sent: ' + info.response);
    });

    res.send("Your Roam has been canceled"); 
  });
});

var PORT = process.env.PORT || 3000;

app.listen(PORT, function(){
  console.log('Example app listening on port', PORT, '!');
});
