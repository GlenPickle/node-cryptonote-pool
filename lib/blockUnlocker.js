var async = require('async');

var apiInterfaces = require('./apiInterfaces.js')(config.daemon, config.wallet);

var logSystem = 'unlocker';
require('./exceptionWriter.js')(logSystem);


log('info', logSystem, 'Started');


//Use this in payment processing to get block info once batch RPC is supported
/*
var batchArray = [
    ['getblockheaderbyheight', {height: 21}],
    ['getblockheaderbyheight', {height: 22}],
    ['getblockheaderbyheight', {height: 23
    }]
];

apiInterfaces.batchRpcDaemon(batchArray, function(error, response){

});
*/


function runInterval(){
    async.waterfall([

        //Get all block candidates in redis
        function(callback){
            redisClient.zrange(config.coin + ':blocks:candidates', 0, -1, 'WITHSCORES', function(error, results){
                if (error){
                    log('error', logSystem, 'Error trying to get pending blocks from redis %j', [error]);
                    callback(true);
                    return;
                }
                if (results.length === 0){
                    log('info', logSystem, 'No blocks candidates in redis');
                    callback(true);
                    return;
                }

                var blocks = [];

                for (var i = 0; i < results.length; i += 2){
                    var parts = results[i].split(':');
                    blocks.push({
                        serialized: results[i],
                        height: parseInt(results[i + 1]),
                        hash: parts[0],
                        time: parts[1],
                        difficulty: parts[2],
                        shares: parts[3]
                    });
                }

                callback(null, blocks);
            });
        },

        //Check if blocks are orphaned
        function(blocks, callback){
            async.filter(blocks, function(block, mapCback){
                apiInterfaces.rpcDaemon('getblockheaderbyheight', {height: block.height}, function(error, result){
                    if (error){
                        log('error', logSystem, 'Error with getblockheaderbyheight RPC request for block %s - %j', [block.serialized, error]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    if (!result.block_header){
                        log('error', logSystem, 'Error with getblockheaderbyheight, no details returned for %s - %j', [block.serialized, result]);
                        block.unlocked = false;
                        mapCback();
                        return;
                    }
                    var blockHeader = result.block_header;
                    block.orphaned = blockHeader.hash === block.hash ? 0 : 1;
                    block.unlocked = blockHeader.depth >= config.blockUnlocker.depth;
                    block.reward = blockHeader.reward;
                    mapCback(block.unlocked);
                });
            }, function(unlockedBlocks){

                if (unlockedBlocks.length === 0){
                    log('info', logSystem, 'No pending blocks are unlocked yet (%d pending)', [blocks.length]);
                    callback(true);
                    return;
                }

                callback(null, unlockedBlocks)
            })
        },

        //Get worker shares for each unlocked block
        function(blocks, callback){


            var redisCommands = blocks.map(function(block){
                return ['hgetall', config.coin + ':shares:round' + block.height];
            });


            redisClient.multi(redisCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with getting round shares from redis %j', [error]);
                    callback(true);
                    return;
                }
                for (var i = 0; i < replies.length; i++){
                    var workerShares = replies[i];
                    blocks[i].workerShares = workerShares;
                }
                callback(null, blocks);
            });
        },

        //Handle orphaned blocks
        function(blocks, callback){
            var orphanCommands = [];

            blocks.forEach(function(block){
                if (!block.orphaned) return;

                orphanCommands.push(['del', config.coin + ':shares:round' + block.height]);

                orphanCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
                orphanCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned
                ].join(':')]);

                if (block.workerShares) {
                    var workerShares = block.workerShares;
                    Object.keys(workerShares).forEach(function (worker) {
                        orphanCommands.push(['hincrby', config.coin + ':shares:roundCurrent', worker, workerShares[worker]]);
                    });
                }
            });

            if (orphanCommands.length > 0){
                redisClient.multi(orphanCommands).exec(function(error, replies){
                    if (error){
                        log('error', logSystem, 'Error with cleaning up data in redis for orphan block(s) %j', [error]);
                        callback(true);
                        return;
                    }
                    callback(null, blocks);
                });
            }
            else{
                callback(null, blocks);
            }
        },

        //Handle unlocked blocks
        function(blocks, callback){
            var unlockedBlocksCommands = [];
            var payments = {};
            var totalBlocksUnlocked = 0;
            blocks.forEach(function(block){
                if (block.orphaned) return;
                totalBlocksUnlocked++;

                /* found a block, now randomly select winners and make payments */

                unlockedBlocksCommands.push(['del', config.coin + ':shares:round' + block.height]);
                unlockedBlocksCommands.push(['zrem', config.coin + ':blocks:candidates', block.serialized]);
                unlockedBlocksCommands.push(['zadd', config.coin + ':blocks:matured', block.height, [
                    block.hash,
                    block.time,
                    block.difficulty,
                    block.shares,
                    block.orphaned,
                    block.reward
                ].join(':')]);

                //Get worker keys
                redisClient.keys(config.coin + ':workers:*', function(error, result) {
                    if (error) {
                        log('error', logSystem, 'Error trying to get worker balances from redis %j', [error]);
                        callback(true);
                        return;
                    }
                    callback(null, result);
                });
        
                var redisCommands = keys.map(function(k){
                    return ['hget', k, 'balance'];
                });
                redisClient.multi(redisCommands).exec(function(error, replies){
                    if (error){
                        log('error', logSystem, 'Error with getting balances from redis %j', [error]);
                        callback(true);
                        return;
                    }
                    var balances = {};
                    var workers = [];
                    for (var i = 0; i < replies.length; i++){
                        var parts = keys[i].split(':');
                        var workerId = parts[parts.length - 1];
                        workers[i] = workerId;
                    }
                    callback(null, workers);
                });
        
                var payments = {};
        
                var transferCommands = [];
        
                var transferCommandsLength = Math.ceil(Object.keys(payments).length / config.payments.maxAddresses);
        
                for (var i = 0; i < transferCommandsLength; i++){
                    transferCommands.push({
                        redis: [],
                        amount : 0,
                        rpc: {
                            destinations: [],
                            fee: config.payments.transferFee,
                            mixin: config.payments.mixin,
                            unlock_time: 0
                        }
                    });
                }
        
                var addresses = 0;
                var commandIndex = 0;
    
                num_payouts = Math.floor(block.reward);
                log('info', logSystem, 'workers is %j', [workers]);
                for (var j = 0; j < num_payouts; j++){
                   payments[j] = Random.integer(0,workers.length - 1);
                }
    
                /* TODO make sure payments work */               
/*
                for (var worker in payments){
                    var amount = 1;
                    transferCommands[commandIndex].rpc.destinations.push({amount: amount, address: worker});
                    transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'balance', -amount]);
                    transferCommands[commandIndex].redis.push(['hincrby', config.coin + ':workers:' + worker, 'paid', amount]);
                    transferCommands[commandIndex].amount += amount;
    
                    addresses++;
                    if (addresses >= config.payments.maxAddresses){
                        commandIndex++;
                        addresses = 0;
                    }
                }
    
                var timeOffset = 0;
    
                async.filter(transferCommands, function(transferCmd, cback){
                    apiInterfaces.rpcWallet('transfer', transferCmd.rpc, function(error, result){
                        if (error){
                            log('error', logSystem, 'Error with transfer RPC request to wallet daemon %j', [error]);
                            log('error', logSystem, 'Payments failed to send to %j', transferCmd.rpc.destinations);
                            cback(false);
                            return;
                        }
    
                        var now = (timeOffset++) + Date.now() / 1000 | 0;
                        var txHash = result.tx_hash.replace('<', '').replace('>', '');
    
    
                        transferCmd.redis.push(['zadd', config.coin + ':payments:all', now, [
                            txHash,
                            transferCmd.amount,
                            transferCmd.rpc.fee,
                            transferCmd.rpc.mixin,
                            Object.keys(transferCmd.rpc.destinations).length
                        ].join(':')]);
    
    
                        for (var i = 0; i < transferCmd.rpc.destinations.length; i++){
                            var destination = transferCmd.rpc.destinations[i];
                            transferCmd.redis.push(['zadd', config.coin + ':payments:' + destination.address, now, [
                                txHash,
                                destination.amount,
                                transferCmd.rpc.fee,
                                transferCmd.rpc.mixin
                            ].join(':')]);
                        }
    
    
                        log('info', logSystem, 'Payments sent via wallet daemon %j', [result]);
                        redisClient.multi(transferCmd.redis).exec(function(error, replies){
                            if (error){
                                log('error', logSystem, 'Super critical error! Payments sent yet failing to update balance in redis, double payouts likely to happen %j', [error]);
                                log('error', logSystem, 'Double payments likely to be sent to %j', transferCmd.rpc.destinations);
                                cback(false);
                                return;
                            }
                            cback(true);
                        });
                    });
                }, function(succeeded){
                    var failedAmount = transferCommands.length - succeeded.length;
                    log('info', logSystem, 'Payments splintered and %d successfully sent, %d failed', [succeeded.length, failedAmount]);
                    callback(null);
                });
*/    

                /* TODO clear worker database so that only current workers are paid for the next block */

            });

            for (var worker in payments) {
                var amount = parseInt(payments[worker]);
                if (amount <= 0){
                    delete payments[worker];
                    continue;
                }
                unlockedBlocksCommands.push(['hincrby', config.coin + ':workers:' + worker, 'balance', amount]);
            }

            if (unlockedBlocksCommands.length === 0){
                log('info', logSystem, 'No unlocked blocks yet (%d pending)', [blocks.length]);
                callback(true);
                return;
            }

            redisClient.multi(unlockedBlocksCommands).exec(function(error, replies){
                if (error){
                    log('error', logSystem, 'Error with unlocking blocks %j', [error]);
                    callback(true);
                    return;
                }
                log('info', logSystem, 'Unlocked %d blocks and update balances for %d workers', [totalBlocksUnlocked, Object.keys(payments).length]);
                callback(null);
            });
        }
    ], function(error, result){
        setTimeout(runInterval, config.blockUnlocker.interval * 1000);
    })
}

runInterval();
