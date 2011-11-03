var net = require('net');
var LDAPHandler = require('./ldap.js').LDAPHandler;
var colors = require('colors');
var util = require('./util.js').util;
var sys = require('sys');
var drink_db = require('./mysql.js').DB;


function SundayServer(drink_config, logger){
    var self = this;

    self.logger = logger;

    //sys.puts(self.sunday_time().cyan + ' - Sunday server created');
    self.logger.log([{msg:self.sunday_time(), color: 'cyan'}, {msg: ' - Sunday server created', color: null}], 0);

    for(var i in drink_config.sunday){
        if(!(i in self)){
            self[i] = drink_config.sunday[i];
        }
    }
    
    self.machine_ip_mapping = drink_config.machine_ip_mapping;
    self.machines = {};
    self.server = null;
    self.machine_server = null;

    self.error_codes = drink_config.error_codes;

    self.machine_codes = drink_config.machine_codes;

}

SundayServer.prototype = {
    sunday_time: function(conn){
        var self = this;

        if(typeof conn != 'undefined' && conn.authenticated == true){
            return util.get_time() + ' (sunday : ' + conn.username + ')';
        } else {
            return util.get_time() + ' (sunday)';
        }

    },
    set_machine_server: function(machine_server){
        var self = this;

        self.machine_server = machine_server;

    },
    init: function(){
        var self = this;

        self.server = net.createServer(function(socket){

            var conn = {};
            
            conn.username = null;
            conn.password = null;
            conn.authenticated = false;
            conn.auth_type = null;
            conn.ibutton = null;
            conn.current_machine = null;
            conn.balance = null;

            conn.ldap_handler = new LDAPHandler(self.logger);

            socket.on('connect', function(data){
                self.logger.log([{msg: self.sunday_time(conn), color: 'cyan'}, {msg: ' - Client connected from ' + socket.remoteAddress, color: null}], 0);

                var machine_name = 'Drink';
                
                if(socket.address().address in self.machine_ip_mapping){
                    conn.current_machine = self.machine_ip_mapping[socket.address().address];
                    machine_name = self.machine_server.machines[conn.current_machine].long_name;
                } else {
                    conn.current_machine = 'd';
                }

                socket.write("Welcome to " + machine_name + "\n");
            });

            socket.on('data', function(data){
                var str_data = data.toString();
                // remove CRLF
                str_data = str_data.replace("\n", "").replace("\r", "");

                // split on space to get commands
                var tokenized_data = str_data.split(" ");

                if(tokenized_data.length > 0){
                    tokenized_data[0] = tokenized_data[0].toUpperCase();
                    if(tokenized_data[0] in self){
                        self[tokenized_data[0]](tokenized_data, socket, conn);
                    } else {
                        self.send_msg_code('415', socket);
                    }
                } else {
                    self.send_msg_code('415', socket);
                }

            });

            socket.on('close', function(data){

            });

        });

        self.server.listen(self.port, self.host);
        self.logger.log([{msg: self.sunday_time(), color: 'cyan'}, {msg: ' - Sunday server running on ' + self.host + ':' + self.port, color: null}], 0);
    },
    /**
     * Sets a username to be authenticated
     *
     * @param command   Tokenized command with arguments - USER <username>
     * @param socket    Reference to the current clients socket
     * @param conn      Reference to the current clients connection session object
     */
    USER: function(command, socket, conn){
        var self = this;

        if(command.length != 2){
            self.send_msg_code('206', socket, ' USAGE: PASS <username>');
            return;
        }

        // store the username
        if(conn.username != command[1]){
            conn.username = command[1];
        }
        
        self.send_msg_code('OK', socket);
       
    },
    /**
     * Sets a password to be authenticated. Requires a username first. Authenticates against LDAP when provided
     *
     * @param command   Toeknized command with arguments - PASS <password>
     * @param socket    Reference to the current clients socket
     * @param conn      Reference to the current clients connection session object
     */
    PASS: function(command, socket, conn){
        var self = this;

        // check for invalid arg count
        if(command.length != 2){
            self.send_msg_code('206', socket, ' USAGE: PASS <username>');
            return;
        }
        
        // need username first
        if(conn.username == null){

            self.send_msg_code('201', socket);
        }

        // check the username/password against ldap
        conn.ldap_handler.auth_user(conn.username, command[1], function(result){
            // result is the error code (if any) returned by the LDAP bind.
            // if the result is null, authentication was successful
            if(result != false){
                conn.password = command[1];
                conn.ibutton = result.ibutton;
                conn.is_admin = false;
                conn.authenticated = true;
                conn.auth_type = 'user';
                conn.username = result.username;
                conn.balance = result.balance;

                self.logger.log([{msg: self.sunday_time(conn), color: 'cyan'}, {msg: ' - Authenticated ' + conn.ibutton + ' (' + conn.username + ')', color: null}], 0);

                self.send_msg_code('OK', socket, conn.balance);

            } else {
                self.send_msg_code('407', socket);
            }
        });

    },
    /**
     * Sets the ibutton to authenticate against. Will use the Drink ldap user to check if ibutton is valid and
     * authenticate user,
     *
     * @param command   Tokenized command with arguments = IBUTTON <ibutton>
     * @param socket    Reference to the current clients socket
     * @param conn      Reference to the current clients connection session object
     */
    IBUTTON: function(command, socket, conn){
        var self = this;

        if(command.length != 2){
            self.send_msg_code('206', socket, ' - USAGE: IBUTTON <ibutton number>');
            return;
        }

        conn.ldap_handler.auth_ibutton(command[1], function(result){
            if(result != false){
                conn.ibutton = result.ibutton;
                conn.is_admin = false;
                conn.authenticated = true;
                conn.auth_type = 'ibutton';
                conn.username = result.username;
                conn.balance = result.balance;

                self.logger.log([{msg: self.sunday_time(conn), color: 'cyan'}, {msg: ' - Authenticated ' + conn.ibutton + ' (' + conn.username + ')', color: null}], 0);

                self.send_msg_code('OK', socket, conn.balance);
            } else {
                util.print_error('Could not authenticate ' + command[1], 'sunday - ibutton');
                self.send_msg_code('207', socket);
            }
        });
    },
    /**
     * Gets the balance for an authenticated user.
     *
     * @param command   Tokenized command with arguments - GETBALANCE
     * @param socket    Reference to the current clients socket
     * @param conn      Reference to the current clients connection session object
     */
    GETBALANCE: function(command, socket, conn){
        var self = this;
        if(conn.authenticated == false){
            self.send_msg_code('204', socket);
            return;
        }

        var credentials = null;

        if(conn.auth_type == 'ibutton'){
            credentials = conn.ibutton;
        } else {
            credentials = {username: conn.username, password: conn.password};
        }

        conn.ldap_handler.get_balance(conn.auth_type, credentials, function(balance){
            if(balance != false){
                self.logger.log([{msg: self.sunday_time(conn), color: 'cyan'}, {msg: ' - GETBALANCE ' + conn.username + ' : ' + balance, color: null}], 0);
                self.send_msg_code('OK', socket, balance);
            } else {
                self.send_msg_code('204', socket);
            }
        });
    },
    DROP: function(command, socket, conn){
        var self = this;

        if(conn.current_machine == null){
            self.send_msg_code('413', socket);
            return;
        }

        var drop_slot = null;

        // check to see that slot number is an int
        drop_slot = parseInt(command[1]);
        if(isNaN(drop_slot)){
            self.send_msg_code('409', socket);
            return;
        }

        // check to see that delay (if there is one) is an int
        var drop_delay = 0;

        if(command.length == 3){
            drop_delay = parseInt(command[2]);
            if(isNaN(drop_delay)){
                self.send_msg_code('403', socket);
                return;
            }

        }

        // check to make sure the machine is connected
        if(self.machine_server.machines[conn.current_machine].connected == true){
            drink_db.get_status_for_slot(conn.current_machine, command[1], function(slot){
                
                // check to make sure slot is "real"
                if(slot != null && slot != false){

                    // check to see if slot is not empty and is enabled
                    if(slot.available > 0 && slot.status == 'enabled'){
                        
                        //check to see if user has the funds
                        if(parseInt(conn.balance) >= parseInt(slot.item_price)){

                            self.machine_server.machines[conn.current_machine].machine_inst.DROP(drop_slot, drop_delay, function(drop_response){

                                var response = '';
                                console.log(drop_response);
                                try {
                                    response = drop_response.substr(0, 1);
                                }
                                catch(e){
                                    util.print_error(e, 'sunday - parsing drop response');
                                }

                                if(response == 4){
                                    // drop successful, deduct credits
                                    conn.ldap_handler.update_balance(conn.username, new_balance, function(msgid, err){
                                        if(err == null){

                                            // log drop to drink db
                                            drink_db.get_machine_id_for_alias(conn.current_machine, function(machine_id){
                                                if(machine_id != null){
                                                    drink_db.log_drop(machine_id, conn.username, drop_slot, slot.item_id, parseInt(slot.item_price), 'ok', function(res){
                                                        self.send_msg_code('OK', socket, ' Dropping drink');

                                                        // check the hardware for slot availability
                                                        self.machine_server.machines[conn.current_machine].machine_inst.check_slot_availability();
                                                        
                                                    });
                                                } else {
                                                    self.send_msg_code('103', socket, ' Bad Machine ID');
                                                }
                                            });
                                        } else {
                                            // something happened oh noes!!
                                            self.send_msg_code('103', socket, ' LDAP Error');
                                        }
                                    });
                                } else {
                                    // couldnt drop drink from slot
                                    self.send_msg_code('150', socket);
                                    return;
                                }
                            });
                            // drop that drink!!

                            var new_balance = parseInt(conn.balance) - parseInt(slot.item_price);

                        } else {
                            // user is poor
                            self.send_msg_code('203', socket);
                            return;
                        }

                    } else {
                        // slot is disabled
                        if(slot.status == 'disabled'){
                            self.send_msg_code('102', socket);
                        }

                        // slot is empty
                        if(slot.available == 0){
                            self.send_msg_code('100', socket);
                        }

                        return;
                    }
                } else {
                    if(slot == false){
                        self.send_msg_code('105', socket);
                    } else {
                        // error - slot not available or something
                        self.send_msg_code('103', socket, 'Slot not available or something');
                        return;
                    }

                }
            });
        } else {
            self.send_msg_code('151', socket);
        }
    },
    /**
     * Gets the stats for the current machine.
     *
     * @param command   Tokenized command with arguments - STAT
     * @param socket    Reference to the current clients socket
     * @param conn      Reference to the current clients connection session object
     */
    STAT: function(command, socket, conn){
        var self = this;

        self.logger.log([{msg: self.sunday_time(), color: 'cyan'}, {msg:' - STAT', color: null}], 0);

        drink_db.get_stat_for_machine(conn.current_machine, function(err, stats){
            if(err == null){
                var stat_string = '';

                for(var i = 0; i < stats.length; i++){
                    var status = (stats[i].status == 'enabled') ? 1 : 0;
                    stat_string += stats[i].slot_num + ' "' + stats[i].item_name + '" ' + stats[i].item_price + ' ' + stats[i].available + ' ' + status + "\n";
                }

                stat_string += "OK " + stats.length + " Slots retrieved";

                self.send_msg_code("OK_ALT", socket, stat_string);

            } else {
                // error getting stat
                self.send_msg_code("416", socket);
            }
        });


    },
    TEMP: function(command, socket, conn){
        var self = this;

        // TODO - get temperature 
    },
    /**
     * Select a drink/snack machine
     * 
     * @param command   Tokenized command with arguments - MACHINE <machine id>
     * @param socket    Reference to the current clients socket
     * @param conn      Reference to the current clients connection session object
     */
    MACHINE: function(command, socket, conn){
        var self = this;

        if(command.length != 2){
            self.send_msg_code('206', socket, ' - USAGE: MACHINE < d | ld | s >');
            return;
        }

        if(command[1] in self.machine_server.machines){
            conn.current_machine = command[1];

            self.logger.log([{msg: self.sunday_time(conn), color: 'cyan'}, {msg: ' - Changing machine to ' + self.machine_server.machines[command[1]].long_name, color: null}], 0);

            self.send_msg_code('OK', socket, ' Welcome to ' + self.machine_server.machines[command[1]].long_name);

        } else {
            self.send_msg_code('414', socket, ' - USAGE: MACHINE < d | ld | s >');
        }
    },
    /**
     * Send credits to another user
     *
     * @param command
     * @param socket
     * @param conn
     */
    SENDCREDITS: function(command, socket, conn){
        var self = this;

        if(command.length != 3){
            self.send_msg_code('206', socket, ' - USAGE: SENDCREDITS <username> <num credits>');
            return;
        }

        if(conn.authenticated == false){
            self.send_msg_code('204', socket);
            return;
        }

        // check to see that the credit amount is a number
        var credits = parseInt(command[2]);
        if(isNaN(drop_slot)){
            self.send_msg_code('206', socket, ' - USAGE: SENDCREDITS <username> <num credits>');
            return;
        }

        if(conn.balance >= credits){

        } else {
            self.send_msg_code('203', socket);
        }
    },
    QUIT: function(command, socket, conn){
        socket.end("Good Bye\r\n");
    },
    WHOAMI: function(command, socket, conn){
        var self = this;
        if(conn.authenticated == true){
            self.send_msg_code('OK', socket, ' ' + conn.username)
        } else {
            self.send_msg_code('204', socket);
        }
    },
    send_msg_code: function(code, socket, message){
        var self = this;
        var error_msg = self.error_codes[code];

        if(typeof message != 'undefined'){
            error_msg += message;
        }
        try {
            socket.write(error_msg + "\r\n");
        } catch (e){
            util.print_error(e, 'sunday - send_msg_code');
        }

        return;
    }
};

exports.server = SundayServer;
