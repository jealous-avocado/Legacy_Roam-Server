db.cypherAsync({query: 'MATCH n:User WHERE n.email={creatorEmail} SET n.status="INACTIVE"', params:{creatorEmail: roamInfo.creatorEmail}});

