'use strict';

var express = require('express');
var app = express();
var bodyParser = require('body-parser');
var bcrypt = require('bcrypt');
var crypto = require('crypto');
var yelp = require('./Utils/api');
var nodemailer = require('nodemailer');
var gmailKeys = require('./Utils/apiKeys').gmailKeys;
var formattedDateHtml = require('./Utils/dateFormatter');
var generateEmail = require('./Utils/emailGenerator');
var boundingBoxGenerator = require('./Utils/boundingBoxGenerator');
var roamOffGenerator = require('./Utils/roamOffGenerator');
var Promise = require('bluebird');
var saltRounds = 10;
var _ = require('underscore');
//neo4j database config
var neo4j = require("neo4j");
var db = new neo4j.GraphDatabase("http://ROAM:LP39ylgXrAGEBmN00GIy@roam.sb05.stations.graphenedb.com:24789");
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

  var data = req.body;
  console.log('data from signup', data);

  //Check database to see if incoming email on signup already exists
  db.cypherAsync({query: 'MATCH (n:User {email: {email}}) RETURN n', params: { email: data.email }})
    .then(function(result) {
      result = result[0];

      if (result) {
        console.log('query res: ', JSON.stringify(result['n'], null, 4));
      } else {
      //If there is no matching email in the database
      //Hash password upon creation of account
        bcrypt.genSalt(saltRounds, function(err, salt) {
          if (err) {
            console.log('Error generating salt', err);
          }
          bcrypt.hash(req.body.password, salt, function(err, hash) {
            if (err) {
              console.log('Error hashing password', err);
            }
            data.email = data.email.toLowerCase();
            data.password = hash;
            //Creates new server in database
            db.cypherAsync({query: 'CREATE (newUser:User {firstName: {firstName}, lastName: {lastName}, password: {password}, email: {email}, picture: {picture}, fb: {fb}});', params: data}).then(
              () => {
                res.send(JSON.stringify({message: 'User created'}));
              })
              .catch((fail) => {
                console.log('issues saving to database:', fail);
              }
            );
          });
        }); //close genssalt
      }
    })
    .catch(e => console.log('error: ', e)); //closing 'then'
}); //close post request

//Validation for sign in page
app.post('/signin', function(req, res){
  var data = req.body;
  console.log('data from facebook signin', data);

  db.cypherAsync({query: 'MATCH (n:User {email: {email}}) RETURN n.password', params: {email: data.email}}).then(function(result){
    if(!result) {
      res.send(JSON.stringify({message: '1.Incorrect email/password combination!'}));
    } else {
      console.log('in here!');
      var password = result[0]['n.password'];
      bcrypt.compare(data.password, password, function(err, bcryptRes){
       if(err){
        console.log('error in comparing password:', err);
       }
        else if(bcryptRes){
          console.log('in here now!!!!');
          res.send(JSON.stringify({message: 'Password Match'}));
        } else {
          res.send(JSON.stringify({message: '2.Incorrect email/password combination!'}));
        }
      });
    }
  });
});

//Page to set up event between users, making API calls to YELP
app.post('/roam', function(req, res) {
  console.log(JSON.stringify(req.body));

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
  console.log('about to query db');

  //Checks to make sure if there is an existing pending roam within similar location by a different user
  db.cypherAsync({query: 'MATCH (n:Roam) WHERE n.creatorRoamEnd > {currentDate} AND n.creatorLatitude < {maxLat} AND n.creatorLatitude > {minLat} AND n.creatorLongitude < {maxLong} AND n.creatorLongitude > {minLong} AND n.creatorEmail <> {userEmail} AND n.numRoamers < {Roamers} AND n.maxRoamers = {Roamers} RETURN n', params: {currentDate:dateMS, maxLat: coords.maxLat, minLat: coords.minLat, maxLong: coords.maxLong, minLong: coords.minLong, userEmail: userEmail, Roamers: Roamers, maxRoamers: Roamers}}).then(function(matchResults) {

    console.log(matchResults, 'MATCH RESULST');
    
    //if no match found create a pending roam node
    if (!matchResults.data) {
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
        db.cypherAsync({query: 'CREATE (m:Roam {creatorEmail: {userEmail}, creatorLatitude: {userLatitude}, creatorLongitude: {userLongitude}, creatorRoamStart: {startRoam}, creatorRoamEnd: {roamOffAfter}, numRoamers: 1, maxRoamers: {Roamers}, status: "Pending", venueName: {venueName}, venueAddress: {venueAddress}})', params: { Roamers: Roamers, email: userEmail, userEmail: userEmail, userLatitude: coords.userLatitude, userLongitude: coords.userLongitude,
      startRoam: times.startRoam, roamOffAfter: times.roamOffAfter, venueName: venueName, venueAddress: venueAddress }}).then(function(queryRes) {

          // creates the relationship between creator of roam node and the roam node
          db.cypherAsync({query: 'MATCH (n:User {email:{email}}), (m:Roam {creatorEmail: {creatorEmail}, creatorRoamStart: {roamStart}}) CREATE (n)-[:CREATED]->(m)', params: {email:userEmail, creatorEmail: userEmail, roamStart: times.startRoam} }).then(function(relationshipRes) {
             console.log('Relationship created', relationshipRes); 
          });
        });
      });
    
    res.send('No match currently');

    } else { //Roam node found within a similar geographic location
      console.log('Found a match', matchResults.data.graph.nodes[0].id);

      var id = matchResults.data.graph.nodes[0].id;

      //Grabs roam node between similar location, and creates the relationship between node and user
      db.cypherAsync({query: 'MATCH (n:User {email:{email}}), (m:Roam) WHERE id(m) = {id} SET m.numRoamers=m.numRoamers+1, m.status="Active" CREATE (n)-[:CREATED]->(m) RETURN m', params: {email:userEmail, id:id}} ).then(function(roamRes) {
          console.log('Relationship created b/w Users created', roamRes[0].data[0].row[0]);
          var roamInfo = roamRes.data[0].row[0];

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

          //If roam match has occured, when max time is reached, change status to Completed
          (() => {
            console.log(roamInfo);
            //this time will be when to set the roam to completed.
            //for now, just wait 30 seconds though
            console.log('timeRemaining', (roamInfo.creatorRoamEnd - new Date().getTime()) / (1000*60), 'minutes');
            setTimeout(()=>{
              console.log('changing roam status to Completed', roamInfo.creatorEmail);
              db.cypherAsync({query: 'MATCH (m:Roam {creatorEmail: {creatorEmail}}) WHERE m.status="Active" SET m.status="Completed" RETURN m', params: {creatorEmail: roamInfo.creatorEmail}});  
            }, 30000);
          })();

          res.send("You have been matched!"); 
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
  db.cypherAsync({query: 'MATCH (m:Roam {creatorEmail: {userEmail}}) WHERE m.status="Pending" SET m.status="Canceled" RETURN m', params: {userEmail: userEmail}}).then(function(cancelRes){

    console.log('Roam canceled:', cancelRes.data[0].row[0]);

    var roamInfo = cancelRes.data[0].row[0];

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

//Check for recently completed roams
app.get('/finished', function(req, res){
  var userEmail = req.query.email;
  console.log('useremail is:', userEmail);

  db.cypherAsync({query: 'MATCH (n:User {email:{email}})-[:CREATED]->(m:Roam{status:"Completed"}) return m', params: {email:userEmail}}).then((queryRes)=> {
    queryRes = queryRes[0];
    if(!queryRes){
      res.json({
        venue: '',
        id: null
      });
    } else {
      console.log(JSON.stringify(queryRes['m'], 4, 2));
      console.log(queryRes['m']._id);
      res.json({
        venue: queryRes['m'].properties.venueName,
        id: queryRes['m']._id
      });
    }
  });
});

//Save roam ratings from user
app.post('/finished', function(req, res){
  var userEmail = req.body.email;
  var rating = +req.body.rating; //number coercion
  var roamId = +req.body.roamId; //number coercion

  console.log(userEmail, rating, roamId);

  db.cypherAsync({query: 'MATCH (n:User {email:{email}})-[r]->(m:Roam{status:"Completed"}) WHERE id(m)={id} CREATE (n)-[:ROAMED{rated:{rating}}]->(m) DELETE r return m', params: {email:userEmail, id:roamId, rating:rating}}).then((queryRes)=>{
    res.send('rating success');
  });
});

//Get all completed, rated roams for user
app.get('/history', function(req, res){
  var userEmail = req.query.email;
  console.log('useremail is:', userEmail);

  db.cypherAsync({query: 'MATCH (n:User {email:{email}})-[r:ROAMED]->(m:Roam{status:"Completed"})<--(p:User)  RETURN r,m,p', params: {email: userEmail}}).then(function(queryRes){
    var organizedData = [];
    queryRes.data.forEach((roamData)=>{
      console.log(roamData.row[0]);
      var newRoam = {roam: {}, people: []};
      newRoam.roam.rating = roamData.row[0].rated;
      newRoam.roam.location = roamData.row[1].venueName;
      newRoam.roam.date = roamData.row[1].creatorRoamStart;
      if(Array.isArray(roamData.row[2])){
        roamData.row[2].forEach((person)=>{
          console.log(person);
          newRoam.people.push({name: person.firstName + ' ' + person.lastName});
        });        
      } else {
        newRoam.people.push({name: roamData.row[2].firstName + ' ' + roamData.row[2].lastName});
      }
      organizedData.push(newRoam);
    })
    console.log(queryRes[0].data);
    res.json(organizedData);
  }, function(fail){
    console.log(fail);
  });
});

var PORT = process.env.PORT || 3000;

app.listen(PORT, function(){
  console.log('Example app listening on THE port', PORT, '!!');
});