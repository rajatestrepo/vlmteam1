'use strict';
/*
* Copyright IBM Corp All Rights Reserved
*
* SPDX-License-Identifier: Apache-2.0
*/
/*
 * Chaincode Invoke
 */

var Fabric_Client = require('fabric-client');
var path = require('path');
var util = require('util');
var os = require('os');

//
// var fabric_client = new Fabric_Client();

// // setup the fabric network
// var channel = fabric_client.newChannel('tfbcchannel');
// var order = fabric_client.newOrderer('grpc://localhost:7050')
// channel.addOrderer(order);
// //add buyer peer
// var peer = fabric_client.newPeer('grpc://localhost:8051');
// channel.addPeer(peer);

//
var member_user = null;
var store_path = path.join(__dirname, 'hfc-key-store');
console.log('Store path:'+store_path);
var tx_id = null;


// // Request LC by Buyer
function placeorder(req, res) {

//Init fabric client
var fabric_client = new Fabric_Client();

// setup the fabric network
var channel = fabric_client.newChannel('tfbcchannel');
var order = fabric_client.newOrderer('grpc://localhost:7050')
channel.addOrderer(order);

//add buyer peer
var peer = fabric_client.newPeer('grpc://localhost:7051');
channel.addPeer(peer);

Fabric_Client.newDefaultKeyValueStore({ path: store_path
}).then((state_store) => {

	
	
	// assign the store to the fabric client
	fabric_client.setStateStore(state_store);
	var crypto_suite = Fabric_Client.newCryptoSuite();
	// use the same location for the state store (where the users' certificate are kept)
	// and the crypto store (where the users' keys are kept)
	var crypto_store = Fabric_Client.newCryptoKeyStore({path: store_path});
	crypto_suite.setCryptoKeyStore(crypto_store);
	fabric_client.setCryptoSuite(crypto_suite);

	// get the enrolled user from persistence, this user will sign all requests
	return fabric_client.getUserContext('manuUser', true);
}).then((user_from_store) => {
	if (user_from_store && user_from_store.isEnrolled()) {
		console.log('Successfully loaded buyerUser from persistence');
		member_user = user_from_store;
	} else {
		throw new Error('Failed to get buyerUser.... run registerUser.js');
	}

	// get a transaction id object based on the current user assigned to fabric client
	tx_id = fabric_client.newTransactionID();
	console.log("Assigning transaction_id: ", tx_id._transaction_id);

	// createCar chaincode function - requires 5 args, ex: args: ['CAR12', 'Honda', 'Accord', 'Black', 'Tom'],
	// changeCarOwner chaincode function - requires 2 args , ex: args: ['CAR10', 'Dave'],
	// must send the proposal to endorsing peers
	var request = {chaincodeId: 'tfbccc',
		fcn: 'placeOrder',
		args: [req.body., req.body.expiryDate, req.body.buyer, req.body.bank, req.body.seller, req.body.amount],
		chainId: 'tfbcchannel',
		txId: tx_id};

	// send the transaction proposal to the peers
	return channel.sendTransactionProposal(request);
}).then((results) => {
	var proposalResponses = results[0];
	var proposal = results[1];
	let isProposalGood = false;
	if (proposalResponses && proposalResponses[0].response &&
		proposalResponses[0].response.status === 200) {
			isProposalGood = true;
			console.log('Transaction proposal was good');
		} else {
			console.error('Transaction proposal was bad');
		}
	if (isProposalGood) {
		console.log(util.format(
			'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s"',
			proposalResponses[0].response.status, proposalResponses[0].response.message));

		// build up the request for the orderer to have the transaction committed
		var request = {
			proposalResponses: proposalResponses,
			proposal: proposal
		};

		// set the transaction listener and set a timeout of 30 sec
		// if the transaction did not get committed within the timeout period,
		// report a TIMEOUT status
		var transaction_id_string = tx_id.getTransactionID(); //Get the transaction ID string to be used by the event processing
		var promises = [];

		var sendPromise = channel.sendTransaction(request);
		promises.push(sendPromise); //we want the send transaction first, so that we know where to check status

		// get an eventhub once the fabric client has a user assigned. The user
		// is required bacause the event registration must be signed
		let event_hub = fabric_client.newEventHub();
		event_hub.setPeerAddr('grpc://localhost:8053');

		// using resolve the promise so that result status may be processed
		// under the then clause rather than having the catch clause process
		// the status
		let txPromise = new Promise((resolve, reject) => {
			let handle = setTimeout(() => {
				event_hub.disconnect();
				resolve({event_status : 'TIMEOUT'}); //we could use reject(new Error('Trnasaction did not complete within 30 seconds'));
			}, 3000);
			event_hub.connect();
			event_hub.registerTxEvent(transaction_id_string, (tx, code) => {
				// this is the callback for transaction event status
				// first some clean up of event listener
				clearTimeout(handle);
				event_hub.unregisterTxEvent(transaction_id_string);
				event_hub.disconnect();

				// now let the application know what happened
				var return_status = {event_status : code, tx_id : transaction_id_string};
				if (code !== 'VALID') {
					console.error('The transaction was invalid, code = ' + code);
					resolve(return_status); // we could use reject(new Error('Problem with the tranaction, event status ::'+code));
				} else {
					console.log('The transaction has been committed on peer ' + event_hub._ep._endpoint.addr);
					resolve(return_status);
				}
			}, (err) => {
				//this is the callback if something goes wrong with the event registration or processing
				reject(new Error('There was a problem with the eventhub ::'+err));
			});
		});
		promises.push(txPromise);

		return Promise.all(promises);
	} else {
		console.error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
		throw new Error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
	}
}).then((results) => {
	console.log('Send transaction promise and event listener promise have completed');
	// check the results in the order the promises were added to the promise all list
	if (results && results[0] && results[0].status === 'SUCCESS') {
		console.log('Successfully sent transaction to the orderer.');
	} else {
		console.error('Failed to order the transaction. Error code: ' + response.status);
		res.send({code:"500", message: "LC request failed."});
	}

	if(results && results[1] && results[1].event_status === 'VALID') {
		console.log('Successfully committed the change to the ledger by the peer');
		res.send({code:"200", message: "LC requested successsfully."});
	} else {
		console.log('Transaction failed to be committed to the ledger due to ::'+results[1].event_status);
	}
}).catch((err) => {
	console.error('Failed to invoke successfully :: ' + err);
	res.send({code:"500", message: "LC request failed."});
});
}

// Issue LC by Bank
function issueLC(req, res) {

		//Init fabric client
		var fabric_client = new Fabric_Client();
	
		// setup the fabric network
		var channel = fabric_client.newChannel('tfbcchannel');
		var order = fabric_client.newOrderer('grpc://localhost:7050')
		channel.addOrderer(order);
		
		//add buyer peer
		var peer = fabric_client.newPeer('grpc://localhost:7051');
		channel.addPeer(peer);	

	Fabric_Client.newDefaultKeyValueStore({ path: store_path
	}).then((state_store) => {
	

		
		// assign the store to the fabric client
		fabric_client.setStateStore(state_store);
		var crypto_suite = Fabric_Client.newCryptoSuite();
		// use the same location for the state store (where the users' certificate are kept)
		// and the crypto store (where the users' keys are kept)
		var crypto_store = Fabric_Client.newCryptoKeyStore({path: store_path});
		crypto_suite.setCryptoKeyStore(crypto_store);
		fabric_client.setCryptoSuite(crypto_suite);
	
		// get the enrolled user from persistence, this user will sign all requests
		return fabric_client.getUserContext('bankUser', true);
	}).then((user_from_store) => {
		if (user_from_store && user_from_store.isEnrolled()) {
			console.log('Successfully loaded bankUser from persistence');
			member_user = user_from_store;
		} else {
			throw new Error('Failed to get bankUser.... run registerUser.js');
		}
	
		// get a transaction id object based on the current user assigned to fabric client
		tx_id = fabric_client.newTransactionID();
		console.log("Assigning transaction_id: ", tx_id._transaction_id);
	
		// createCar chaincode function - requires 5 args, ex: args: ['CAR12', 'Honda', 'Accord', 'Black', 'Tom'],
		// changeCarOwner chaincode function - requires 2 args , ex: args: ['CAR10', 'Dave'],
		// must send the proposal to endorsing peers
		var request = {chaincodeId: 'tfbccc',
	fcn: 'issueLC',
	args: [req.body.lcId],
	chainId: 'tfbcchannel',
	txId: tx_id};
	
		// send the transaction proposal to the peers
		return channel.sendTransactionProposal(request);
	}).then((results) => {
		var proposalResponses = results[0];
		var proposal = results[1];
		let isProposalGood = false;
		if (proposalResponses && proposalResponses[0].response &&
			proposalResponses[0].response.status === 200) {
				isProposalGood = true;
				console.log('Transaction proposal was good');
			} else {
				console.error('Transaction proposal was bad');
			}
		if (isProposalGood) {
			console.log(util.format(
				'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s"',
				proposalResponses[0].response.status, proposalResponses[0].response.message));
	
			// build up the request for the orderer to have the transaction committed
			var request = {
				proposalResponses: proposalResponses,
				proposal: proposal
			};
	
			// set the transaction listener and set a timeout of 30 sec
			// if the transaction did not get committed within the timeout period,
			// report a TIMEOUT status
			var transaction_id_string = tx_id.getTransactionID(); //Get the transaction ID string to be used by the event processing
			var promises = [];
	
			var sendPromise = channel.sendTransaction(request);
			promises.push(sendPromise); //we want the send transaction first, so that we know where to check status
	
			// get an eventhub once the fabric client has a user assigned. The user
			// is required bacause the event registration must be signed
			let event_hub = fabric_client.newEventHub();
			event_hub.setPeerAddr('grpc://localhost:7053');
	
			// using resolve the promise so that result status may be processed
			// under the then clause rather than having the catch clause process
			// the status
			let txPromise = new Promise((resolve, reject) => {
				let handle = setTimeout(() => {
					event_hub.disconnect();
					resolve({event_status : 'TIMEOUT'}); //we could use reject(new Error('Trnasaction did not complete within 30 seconds'));
				}, 3000);
				event_hub.connect();
				event_hub.registerTxEvent(transaction_id_string, (tx, code) => {
					// this is the callback for transaction event status
					// first some clean up of event listener
					clearTimeout(handle);
					event_hub.unregisterTxEvent(transaction_id_string);
					event_hub.disconnect();
	
					// now let the application know what happened
					var return_status = {event_status : code, tx_id : transaction_id_string};
					if (code !== 'VALID') {
						console.error('The transaction was invalid, code = ' + code);
						resolve(return_status); // we could use reject(new Error('Problem with the tranaction, event status ::'+code));
					} else {
						console.log('The transaction has been committed on peer ' + event_hub._ep._endpoint.addr);
						resolve(return_status);
					}
				}, (err) => {
					//this is the callback if something goes wrong with the event registration or processing
					reject(new Error('There was a problem with the eventhub ::'+err));
				});
			});
			promises.push(txPromise);
	
			return Promise.all(promises);
		} else {
			console.error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
			throw new Error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
		}
	}).then((results) => {
		console.log('Send transaction promise and event listener promise have completed');
		// check the results in the order the promises were added to the promise all list
		if (results && results[0] && results[0].status === 'SUCCESS') {
			console.log('Successfully sent transaction to the orderer.');
		} else {
			console.error('Failed to order the transaction. Error code: ' + response.status);
			res.send({code:"500", message: "LC issue failed."});
		}
	
		if(results && results[1] && results[1].event_status === 'VALID') {
			console.log('Successfully committed the change to the ledger by the peer');
			res.send({code:"200", message: "LC issued successsfully."});
		} else {
			console.log('Transaction failed to be committed to the ledger due to ::'+results[1].event_status);
		}
	}).catch((err) => {
		console.error('Failed to invoke successfully :: ' + err.stack);
		res.send({code:"500", message: "LC issue failed."});
	});
	}

// Accept LC by Seller
function acceptLC(req, res) {

	//Init fabric client
	var fabric_client = new Fabric_Client();
	
	// setup the fabric network
	var channel = fabric_client.newChannel('tfbcchannel');
	var order = fabric_client.newOrderer('grpc://localhost:7050')
	channel.addOrderer(order);
	
	//add buyer peer
	var peer = fabric_client.newPeer('grpc://localhost:9051');
	channel.addPeer(peer);

	Fabric_Client.newDefaultKeyValueStore({ path: store_path
	}).then((state_store) => {
	
		
		
		// assign the store to the fabric client
		fabric_client.setStateStore(state_store);
		var crypto_suite = Fabric_Client.newCryptoSuite();
		// use the same location for the state store (where the users' certificate are kept)
		// and the crypto store (where the users' keys are kept)
		var crypto_store = Fabric_Client.newCryptoKeyStore({path: store_path});
		crypto_suite.setCryptoKeyStore(crypto_store);
		fabric_client.setCryptoSuite(crypto_suite);
	
		// get the enrolled user from persistence, this user will sign all requests
		return fabric_client.getUserContext('sellerUser', true);
	}).then((user_from_store) => {
		if (user_from_store && user_from_store.isEnrolled()) {
			console.log('Successfully loaded sellerUser from persistence');
			member_user = user_from_store;
		} else {
			throw new Error('Failed to get sellerUser.... run registerUser.js');
		}
	
		// get a transaction id object based on the current user assigned to fabric client
		tx_id = fabric_client.newTransactionID();
		console.log("Assigning transaction_id: ", tx_id._transaction_id);
	
		// createCar chaincode function - requires 5 args, ex: args: ['CAR12', 'Honda', 'Accord', 'Black', 'Tom'],
		// changeCarOwner chaincode function - requires 2 args , ex: args: ['CAR10', 'Dave'],
		// must send the proposal to endorsing peers
		var request = {chaincodeId: 'tfbccc',
	fcn: 'acceptLC',
	args: [req.body.lcId],
	chainId: 'tfbcchannel',
	txId: tx_id};
	
		// send the transaction proposal to the peers
		return channel.sendTransactionProposal(request);
	}).then((results) => {
		var proposalResponses = results[0];
		var proposal = results[1];
		let isProposalGood = false;
		if (proposalResponses && proposalResponses[0].response &&
			proposalResponses[0].response.status === 200) {
				isProposalGood = true;
				console.log('Transaction proposal was good');
			} else {
				console.error('Transaction proposal was bad');
			}
		if (isProposalGood) {
			console.log(util.format(
				'Successfully sent Proposal and received ProposalResponse: Status - %s, message - "%s"',
				proposalResponses[0].response.status, proposalResponses[0].response.message));
	
			// build up the request for the orderer to have the transaction committed
			var request = {
				proposalResponses: proposalResponses,
				proposal: proposal
			};
	
			// set the transaction listener and set a timeout of 30 sec
			// if the transaction did not get committed within the timeout period,
			// report a TIMEOUT status
			var transaction_id_string = tx_id.getTransactionID(); //Get the transaction ID string to be used by the event processing
			var promises = [];
	
			var sendPromise = channel.sendTransaction(request);
			promises.push(sendPromise); //we want the send transaction first, so that we know where to check status
	
			// get an eventhub once the fabric client has a user assigned. The user
			// is required bacause the event registration must be signed
			let event_hub = fabric_client.newEventHub();
			event_hub.setPeerAddr('grpc://localhost:9053');
	
			// using resolve the promise so that result status may be processed
			// under the then clause rather than having the catch clause process
			// the status
			let txPromise = new Promise((resolve, reject) => {
				let handle = setTimeout(() => {
					event_hub.disconnect();
					resolve({event_status : 'TIMEOUT'}); //we could use reject(new Error('Trnasaction did not complete within 30 seconds'));
				}, 3000);
				event_hub.connect();
				event_hub.registerTxEvent(transaction_id_string, (tx, code) => {
					// this is the callback for transaction event status
					// first some clean up of event listener
					clearTimeout(handle);
					event_hub.unregisterTxEvent(transaction_id_string);
					event_hub.disconnect();
	
					// now let the application know what happened
					var return_status = {event_status : code, tx_id : transaction_id_string};
					if (code !== 'VALID') {
						console.error('The transaction was invalid, code = ' + code);
						resolve(return_status); // we could use reject(new Error('Problem with the tranaction, event status ::'+code));
					} else {
						console.log('The transaction has been committed on peer ' + event_hub._ep._endpoint.addr);
						resolve(return_status);
					}
				}, (err) => {
					//this is the callback if something goes wrong with the event registration or processing
					reject(new Error('There was a problem with the eventhub ::'+err));
				});
			});
			promises.push(txPromise);
	
			return Promise.all(promises);
		} else {
			console.error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
			throw new Error('Failed to send Proposal or receive valid response. Response null or status is not 200. exiting...');
		}
	}).then((results) => {
		console.log('Send transaction promise and event listener promise have completed');
		// check the results in the order the promises were added to the promise all list
		if (results && results[0] && results[0].status === 'SUCCESS') {
			console.log('Successfully sent transaction to the orderer.');
		} else {
			console.error('Failed to order the transaction. Error code: ' + response.status);
			res.send({code:"500", message: "LC accept failed."});
		}
	
		if(results && results[1] && results[1].event_status === 'VALID') {
			console.log('Successfully committed the change to the ledger by the peer');
			res.send({code:"200", message: "LC accepted successsfully."});
		} else {
			console.log('Transaction failed to be committed to the ledger due to ::'+results[1].event_status);
			res.send({code:"500", message: "LC accept failed."});
		}
	}).catch((err) => {
		console.error('Failed to invoke successfully :: ' + err);
		res.send({code:"500", message: "LC accept failed."});
	});
}

// Get current state of LC using Bank user
function getLC(req, res){
	//Init fabric client
	var fabric_client = new Fabric_Client();
	
	// setup the fabric network
	var channel = fabric_client.newChannel('tfbcchannel');
	var order = fabric_client.newOrderer('grpc://localhost:7050')
	channel.addOrderer(order);
	
	//add buyer peer
	var peer = fabric_client.newPeer('grpc://localhost:7051');
	channel.addPeer(peer);


	Fabric_Client.newDefaultKeyValueStore({ path: store_path
	}).then((state_store) => {
		
		// assign the store to the fabric client
		fabric_client.setStateStore(state_store);
		var crypto_suite = Fabric_Client.newCryptoSuite();
		// use the same location for the state store (where the users' certificate are kept)
		// and the crypto store (where the users' keys are kept)
		var crypto_store = Fabric_Client.newCryptoKeyStore({path: store_path});
		crypto_suite.setCryptoKeyStore(crypto_store);
		fabric_client.setCryptoSuite(crypto_suite);
	
		// get the enrolled user from persistence, this user will sign all requests
		return fabric_client.getUserContext('bankUser', true);
	}).then((user_from_store) => {
		if (user_from_store && user_from_store.isEnrolled()) {
			console.log('Successfully loaded bankUser from persistence');
			member_user = user_from_store;
		} else {
			throw new Error('Failed to get bankUser.... run registerUser.js');
		}
	
		// queryCar chaincode function - requires 1 argument, ex: args: ['CAR4'],
		// queryAllCars chaincode function - requires no arguments , ex: args: [''],
		var request = {chaincodeId: 'tfbccc',
		fcn: 'getLC',
		args: [req.body.lcId],
		chainId: 'tfbcchannel',
		};
	
		// send the query proposal to the peer
		return channel.queryByChaincode(request);
	}).then((query_responses) => {
		console.log("Query has completed, checking results");
		// query_responses could have more than one  results if there multiple peers were used as targets
		if (query_responses && query_responses.length == 1) {
			if (query_responses[0] instanceof Error) {
				console.error("error from query = ", query_responses[0]);
				res.send({code:"500", data: "Issue with getting LC details"});
			} else {
				
				console.log("Response is ", query_responses[0].toString());
				res.send({code:"200", data: JSON.parse(query_responses[0].toString())});
			}
		} else {
			console.log("No payloads were returned from query");
			res.send({code:"500", data: "No LC found"});
		}
	}).catch((err) => {
		console.error('Failed to query successfully :: ' + err);
		res.send({code:"500", data: "Issue with getting LC details"});
	});
	
}

// Get current state of LC using Bank user
function getLCHistory(req, res){

	//Init fabric client
	var fabric_client = new Fabric_Client();
	
	// setup the fabric network
	var channel = fabric_client.newChannel('tfbcchannel');
	var order = fabric_client.newOrderer('grpc://localhost:7050')
	channel.addOrderer(order);
	
	//add buyer peer
	var peer = fabric_client.newPeer('grpc://localhost:7051');
	channel.addPeer(peer);

	Fabric_Client.newDefaultKeyValueStore({ path: store_path
	}).then((state_store) => {
		

		// assign the store to the fabric client
		fabric_client.setStateStore(state_store);
		var crypto_suite = Fabric_Client.newCryptoSuite();
		// use the same location for the state store (where the users' certificate are kept)
		// and the crypto store (where the users' keys are kept)
		var crypto_store = Fabric_Client.newCryptoKeyStore({path: store_path});
		crypto_suite.setCryptoKeyStore(crypto_store);
		fabric_client.setCryptoSuite(crypto_suite);
	
		// get the enrolled user from persistence, this user will sign all requests
		return fabric_client.getUserContext('bankUser', true);
	}).then((user_from_store) => {
		if (user_from_store && user_from_store.isEnrolled()) {
			console.log('Successfully loaded bankUser from persistence');
			member_user = user_from_store;
		} else {
			throw new Error('Failed to get bankUser.... run registerUser.js');
		}
	
		// queryCar chaincode function - requires 1 argument, ex: args: ['CAR4'],
		// queryAllCars chaincode function - requires no arguments , ex: args: [''],
		var request = {chaincodeId: 'tfbccc',
		fcn: 'getLCHistory',
		args: [req.body.lcId],
		chainId: 'tfbcchannel',
		};
	
		// send the query proposal to the peer
		return channel.queryByChaincode(request);
	}).then((query_responses) => {
		console.log("Query has completed, checking results");
		// query_responses could have more than one  results if there multiple peers were used as targets
		if (query_responses && query_responses.length == 1) {
			if (query_responses[0] instanceof Error) {
				console.error("error from query = ", query_responses[0]);
				res.send({code:"500", message: "Issue with getting LC details"});
			} else {
				
				console.log("Response is ", query_responses[0].toString());
				res.send({code:"200", data: JSON.parse(query_responses[0].toString())});
			}
		} else {
			console.log("No payloads were returned from query");
			res.send({code:"500", message: "No LC found"});
		}
	}).catch((err) => {
		console.error('Failed to query successfully :: ' + err);
		res.send({code:"500", message: "Issue with getting LC details"});
	});
	
}

let tfbc = {
	requestLC: requestLC,
	issueLC: issueLC,
	acceptLC: acceptLC,
	getLC: getLC,
	getLCHistory: getLCHistory
}

module.exports = tfbc;
