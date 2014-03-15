
var LAST_MESSAGEIDX_RECEIVED = 0; //last message received from the message feed (socket.io) -- used to detect gaps
var FAILOVER_CURRENT_IDX = 0; //last idx in the counterwalletd_base_urls tried (used for socket.io failover)

function tryNextSIOMessageFeed() {
  if(FAILOVER_LAST_IDX_TRIED + 1 == counterwalletd_base_urls.length) {
    FAILOVER_CURRENT_IDX = 0;
  } else {
    FAILOVER_CURRENT_IDX += 1;
  }
  $.jqlog.log('socket.io: Trying next server: ' + url[FAILOVER_CURRENT_IDX]);
  initMessageFeed();
}

function initMessageFeed() {
  //set up a connection to the server event feed via socket.io and handle messages
  var url = counterwalletd_base_urls[FAILOVER_CURRENT_IDX];
  $.jqlog.log("socket.io: Connecting to: " + url);
  //https://github.com/LearnBoost/Socket.IO/wiki/Configuring-Socket.IO
  var socket = io.connect(url, {
    'connect timeout': 5000,
    'reconnect': true,
    'reconnection delay': 500,
    'reconnection limit': 2000,
    'max reconnection attempts': 5,
    'force new connection': true,
    'try multiple transports': false,
    'resource': USE_TESTNET ? '_t_feed' : '_feed'
  });

  //Create a wildcard event handler: http://stackoverflow.com/a/19121009
  var original_$emit = socket.$emit;
  socket.$emit = function() {
      var args = Array.prototype.slice.call(arguments);
      original_$emit.apply(socket, ['*'].concat(args));
      if(!original_$emit.apply(socket, arguments)) {
          original_$emit.apply(socket, ['default'].concat(args));
      }
  }
  /*socket.on('default',function(event, data) {
      $.jqlog.log('socket.io event not trapped: ' + event + ' - data:' + JSON.stringify(data));
  });*/
  socket.on('*',function(event, data) {
      //$.jqlog.log('socket.io message received: ' + event + ' - data:' + JSON.stringify(data));
      if(event == 'connect') {
        $.jqlog.log('socket.io(messages): Connected to server: ' + url);
        socket.emit("subscribe"); //subscribe to the data feed itself
      } else if(event == 'disconnect') {
        $.jqlog.log('socket.io(messages): The client has disconnected from server: ' + url);
      } else if(event == 'connect_failed') {
        $.jqlog.log('socket.io(messages): Connection to server failed: ' + url);
        io.disconnect();
        tryNextSIOMessageFeed();
      } else if(event == 'reconnect_failed') {
        $.jqlog.log('socket.io(messages): Reconnect to the server failed: ' + url);
        io.disconnect();
        tryNextSIOMessageFeed();
      } else if(['connecting', 'connect_error', 'connect_timeout', 'reconnect', 'reconnecting', 'reconnect_error'].indexOf(event) >= 0) {
        //these events currently not handled
      } else{
        assert(data['_category'] !== undefined && event == data['_category'], "Message feed message lacks category field!");
        parseMessageWithFeedGapDetection(event, data);
      }
  });
}

function parseMessageWithFeedGapDetection(category, message) {
  if(!message || (message.substring && message.startswith("<html>"))) return;
  //^ sometimes nginx can trigger this via its proxy handling it seems, with a blank payload (or a html 502 Bad Gateway
  // payload) -- especially if the backend server reloads. Just ignore it.
  $.jqlog.info("feed:RECV MESSAGE=" + category + ", IDX=" + message['_message_index'] + " (last idx: " + LAST_MESSAGEIDX_RECEIVED + ") -- " + JSON.stringify(message));
  if((message['_message_index'] === undefined || message['_message_index'] === null) && IS_DEV) debugger; //it's an odd condition we should look into...
  assert(LAST_MESSAGEIDX_RECEIVED, "LAST_MESSAGEIDX_RECEIVED is not defined! Should have been set from is_ready on logon.");
  assert(message['_message_index'] > LAST_MESSAGEIDX_RECEIVED, "Received message_index is < LAST_MESSAGEIDX_RECEIVED");
  
  //handle normal case that the message we received is the next in order
  if(message['_message_index'] == LAST_MESSAGEIDX_RECEIVED + 1) {
    LAST_MESSAGEIDX_RECEIVED += 1;
    return handleMessage(category, message);
  }
  
  //otherwise, we have a forward gap
  $.jqlog.warn("feed:MESSAGE GAP DETECTED: our last msgidx = " + LAST_MESSAGEIDX_RECEIVED + " --  server sent msgidx = " + message['_message_index']);

  //request the missing messages from the feed and replay them...
  if(IS_DEV) debugger; //temporary...
  var missingMessages = [];
  for(var i=LAST_MESSAGEIDX_RECEIVED+1; i < message['_message_index']; i++) {
    missingMessages.push(i);
  }
  
  failoverAPI("get_messagefeed_messages_by_index", [missingMessages], function(missingMessageData, endpoint) {
    for(var i=0; i < missingMessageData.length; i++) {
      assert(missingMessageData[i]['_message_index'] == missingMessages[i], "Message feed resync list oddity...?");
      handleMessage(missingMessageData[i]['_category'], missingMessageData[i]);
      assert(LAST_MESSAGEIDX_RECEIVED + 1 == missingMessageData[i]['_message_index'], "Message feed resync counter increment oddity...?");
      LAST_MESSAGEIDX_RECEIVED = missingMessageData[i]['_message_index']; 
    }
    //all caught up, call the callback for the original message itself
    handleMessage(category, message);
  });
}

function handleMessage(category, message) {
  //Detect a reorg and refresh the current page if so.
  if(message['_category'] == 'reorg') {
    //Don't need to adjust the message index
    $.jqlog.warn("feed:REORG DETECTED back to block: " + message['block_index']);
    checkURL(); //refresh the current page to regrab the fresh data
    //TODO/BUG??: do we need to "roll back" old messages on the bad chain???
    return;
  }
  
  //filter out non insert messages for now
  if(message['_command'] != 'insert')
    return;

  //remove any pending message from the pending actions pane (we do this before we filter out invalid messages
  // because we need to report on invalid messages)
  if(category != "btcpays") // (btcpays have their own remove method)
    PENDING_ACTION_FEED.removePendingAction(category, message);
  else if(category == "btcpays" && message['status'].startsWith('invalid'))
    PENDING_ACTION_FEED.removePendingBTCPay(message['order_match_id'], message);

  //filter out any invalid messages for action processing itself
  assert(message['_status'].startsWith('valid')
    || message['_status'].startsWith('invalid')
    || message['_status'].startsWith('pending')
    || message['_status'].startsWith('completed'));
  if(message['_status'].startsWith('invalid'))
    return; //ignore message
  
  //notify the user in the notification pane
  NOTIFICATION_FEED.add(category, message);
  //^ especially with issuances, it's important that this line come before we modify state below
  
  //Have the action take effect (i.e. everything besides notifying the user in the notifcations pane, which was done above)
  if(category == "balances") {
  } else if(category == "credits" || category == "debits") {
    if(WALLET.getAddressObj(message['address'])) {
      WALLET.updateBalance(message['address'], message['asset'], message['_balance']);
    }
  } else if(category == "broadcasts") {
    //TODO
  } else if(category == "btcpays") {
    //Remove the BTCpay if the ordermatch is one of the ones in our pending list
    PENDING_ACTION_FEED.removePendingBTCPay(message['order_match_id']);
  } else if(category == "burns") {
  } else if(category == "cancels") {
    if(WALLET.getAddressObj(message['source'])) {
      //If for an order (and we are on the DEx page), refresh the order book if the orders page is displayed
      // and if the cooresponding order is for one of the assets that is being displayed
      if (typeof BUY_SELL !== 'undefined') {
        BUY_SELL.openOrders.remove(function(item) { return item.tx_index == message['offer_hash']});
      } 
      //Also remove the canceled order from the open orders and pending orders list (if present)
      OPEN_ORDER_FEED.remove(message['offer_hash']);
      PENDING_ACTION_FEED.removePendingBTCPayByOrderID(message['offer_hash']);
  
      //TODO: If for a bet, do nothing for now.
    }
  } else if(category == "callbacks") {
    //assets that are totally called back will be removed automatically when their
    // balance goes to zero, via WALLET.updateBalance
  } else if(category == "dividends") {
  } else if(category == "issuances") {
    var addressesWithAsset = WALLET.getAddressesWithAsset(message['asset']);
    for(var i=0; i < addressesWithAsset.length; i++) {
      WALLET.getAddressObj(addressesWithAsset[i]).addOrUpdateAsset(
        message['asset'], message['_quantity_normalized'], message);
    }
  } else if(category == "sends") {
  } else if(category == "orders") {
    if(!WALLET.getAddressObj(message['source'])) {
      //List the order in our open orders list (activities feed)
      OPEN_ORDER_FEED.add(message);
      //Also list the order on open orders if we're viewing the dex page
      if (typeof BUY_SELL !== 'undefined') {
        BUY_SELL.openOrders.push(order);
      }
    }
  } else if(category == "order_matches") {
    if(   (WALLET.getAddressObj(message['tx0_address']) && message['forward_asset'] == 'BTC')
       || (WALLET.getAddressObj(message['tx1_address']) && message['backward_asset'] == 'BTC')) {
      //If here, we got an order match where an address in our wallet owes BTC.
      // This being the case, we must settle up with a BTCPay
      var btcPayData = PendingActionFeedViewModel.makeBTCPayData(message);
      
      //If automatic BTC pays are enabled, just take care of the BTC pay right now
      if(PREFERENCES['auto_btcpay']) {
        if(WALLET.getBalance(btcPayData['myAddr'], 'BTC', false) >= (btcPayData['btcQuantityRaw']) + MIN_PRIME_BALANCE) {
          //user has the sufficient balance
          WALLET.doTransaction(btcPayData['myAddr'], "create_btcpay",
            { order_match_id: btcPayData['orderMatchID'] },
            function() {
              //notify the user of the automatic BTC payment
              bootbox.alert("Automatic BTC payment of <b>"
                + btcPayData['btcQuantity'] + " BTC</b> made from address " + btcPayData['myAddr'] + " for <b>"
                + btcPayData['otherOrderQuantity'] + " " + btcPayData['otherOrderAsset'] + "</b>. " + ACTION_PENDING_NOTICE);
            }, function() {
              PENDING_ACTION_FEED.addPendingBTCPay(btcPayData);
              bootbox.alert("There was an error processing an automatic BTC payment."
                + " This BTC payment has been placed in a pending state. Please try again manually.");
            }
          );
        } else {
          //The user doesn't have the necessary balance on the address... let them know and add the BTC as pending
          PENDING_ACTION_FEED.addPendingBTCPay(btcPayData);
          bootbox.alert("A payment on a matched order for <b>" + btcPayData['btcQuantity'] + " BTC</b> is required,"
            + " however, the address that made the order (" + getAddressLabel(btcPayData['myAddr'])
            + ") lacks the balance necessary to do this automatically. This order has been placed in a pending state."
            + "<br/><br/><b>Please deposit the necessary BTC into this address and manually make the BTC payment from"
            + " the clock icon in the top bar of the site.</b>");  
        }
      } else {
        //Otherwise, prompt the user to make the BTC pay
        var prompt = "An order match for <b>" + btcPayData['otherOrderQuantity'] + " " + btcPayData['otherOrderAsset'] + "</b> was successfully made. "
          + " To finalize, this requires payment of <b>"+ btcPayData['btcQuantity'] + " BTC</b>"
          + " from address " + getAddressLabel(btcPayData['myAddr']) + ".<br/><br/>Pay now?";          
        bootbox.dialog({
          message: prompt,
          title: "Order Settlement (BTC Pay)",
          buttons: {
            success: {
              label: "No, hold off",
              className: "btn-danger",
              callback: function() {
                //If the user says no, then throw the BTC pay in pending BTC pays
                PENDING_ACTION_FEED.addPendingBTCPay(btcPayData);
              }
            },
            danger: {
              label: "Yes",
              className: "btn-success",
              callback: function() {
                WALLET.doTransaction(self.MY_ADDR, "create_btcpay",
                  { order_match_id: btcPayData['orderMatchID'] },
                  function() {
                    //notify the user of the automatic BTC payment
                    bootbox.alert("Automatic BTC payment of <b>" + btcPayData['btcQuantity'] + " BTC</b>"
                      + " made from address " + getAddressLabel(btcPayData['myAddr']) + " for <b>"
                      + btcPayData['otherOrderQuantity'] + " " + btcPayData['otherOrderAsset'] + "</b>. " + ACTION_PENDING_NOTICE);
                  }, function() {
                    PENDING_ACTION_FEED.addPendingBTCPay(btcPayData);
                    bootbox.alert("There was an error processing an automatic BTC payment. Please manually make the payment from"
                      + " the clock icon in the top bar of the site.</b>");
                  }
                );
              }
            },
          }
        });    
      }
    }
  } else if(category == "order_expirations") {
    //Remove the order from the open orders list and pending orders list, if on either
    OPEN_ORDER_FEED.remove(message['order_hash']);
    PENDING_ACTION_FEED.removePendingBTCPayByOrderID(message['order_hash']); //just in case
  } else if(category == "order_match_expirations") {
    //Would happen if the user didn't make a BTC payment in time
    PENDING_ACTION_FEED.removePendingBTCPay(message['order_match_id']);
    OPEN_ORDER_FEED.remove(message['order_match_id']); //just in case
  } else if(category == "bets") {
    //TODO
  } else if(category == "bet_matches") {
    //TODO
  } else if(category == "bet_expirations") {
    //TODO
  } else if(category == "bet_match_expirations") {
    //TODO
  } else {
    $.jqlog.error("Unknown message category: " + category);
  }
}