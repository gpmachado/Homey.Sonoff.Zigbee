const { Cluster, ZCLDataTypes } = require("zigbee-clusters");

/**
 * Sonoff Custom Cluster (0xFC11 / 64529)
 * Manufacturer ID: 0x1286
 * 
 * Handles manufacturer-specific attributes and commands for Sonoff Zigbee devices
 */
class SonoffCluster extends Cluster {

    static get ID() {
        return 0xFC11; // 64529
    }
    
    static get NAME() {
        return 'SonoffCluster';
    }
    
    /**
     * Get list of attributes commonly used by ZBMINIR2 devices
     */
    static get ZBMINIR2_ATTRIBUTES() {
        return [
            'TurboMode',
            'network_led',
            'power_on_delay_state',
            'power_on_delay_time',
            'switch_mode',
            'detach_mode'
        ];
    }
    
    static get ATTRIBUTES() {
        return {
            child_lock: {
                id: 0x0000,
                type: ZCLDataTypes.bool
            },
            TurboMode: {
                // ZBMINIR2 - Extended radio range mode
                // 9 (0x09) = Normal radio power
                // 20 (0x14) = Turbo radio power (extended range)
                id: 0x0012,
                type: ZCLDataTypes.int16
            },        
            power_on_delay_state: {
                // ZBMINIR2 - Enable/disable power-on delay
                id: 0x0014,
                type: ZCLDataTypes.bool        
            },
            power_on_delay_time: {
                // ZBMINIR2 - Power-on delay time in milliseconds
                id: 0x0015,
                type: ZCLDataTypes.uint16
            },
            switch_mode: {
                // ZBMINIR2 - Physical switch mode
                // 0x00 = edge (toggle on press)
                // 0x01 = pulse (momentary)
                // 0x02 = follow_on (follower mode - on)
                // 0x82 = follow_off (follower mode - off)
                id: 0x0016,
                type: ZCLDataTypes.uint8
            },
            detach_mode: {
                // ZBMINIR2 - Detach relay from physical switch
                // When enabled, physical switch sends commands without changing relay
                id: 0x0017,
                type: ZCLDataTypes.bool
            },
            network_led: {
                // ZBMINIR2, switches, plugs - Network status LED control
                id: 0x0001,
                type: ZCLDataTypes.bool
            },
            backlight: {
                // Switches - Backlight control
                id: 0x0002,
                type: ZCLDataTypes.bool
            },
            tamper: {
                id: 0x2000,
                type: ZCLDataTypes.uint8
            },
            illuminance: {
                id: 0x2001,
                type: ZCLDataTypes.uint8
            },
            open_window: {
                id: 0x6000,
                type: ZCLDataTypes.bool
            },
            frost_protection_temperature: {
                id: 0x6002,
                type: ZCLDataTypes.int16
            },
            idle_steps: {
                id: 0x6003,
                type: ZCLDataTypes.uint16
            },
            closing_steps: {
                id: 0x6004,
                type: ZCLDataTypes.uint16
            },
            valve_opening_limit_voltage: {
                id: 0x6005,
                type: ZCLDataTypes.uint16
            },
            valve_closing_limit_voltage: {
                id: 0x6006,
                type: ZCLDataTypes.uint16
            },
            valve_motor_running_voltage: {
                id: 0x6007,
                type: ZCLDataTypes.uint16
            },
            valve_opening_degree: {
                id: 0x600b,
                type: ZCLDataTypes.uint8
            },
            valve_closing_degree: {
                id: 0x600c,
                type: ZCLDataTypes.uint8
            },
        };
    }

    static get COMMANDS() {
        return {
            protocolData: {
                id: 0x01,
                manufacturerSpecific: true,
                manufacturerId: 0x1286,
                args: {
                    data: ZCLDataTypes.buffer
                }
            },
            protocolDataResponse: {
                id: 0x0B, // cmdId 11
                args: {
                    data: ZCLDataTypes.buffer
                }
            }
        };
    }
    
    /**
     * CRITICAL FIX: Intercept standard Zigbee responses for custom cluster
     * 
     * The device sends standard responses that zigbee-clusters doesn't auto-handle
     * for custom clusters, so we must manually intercept them here.
     * 
     * @param {Object} frame - ZCL frame object
     * @param {number} frame.cmdId - Command ID
     * @param {Buffer} frame.data - Command data payload
     * @param {Object} meta - Frame metadata
     * @returns {void}
     */
    handleFrame(frame, meta) {
        // Handle writeAttributesResponse (standard Zigbee command 0x04)
        if (frame.cmdId === 0x04) {
            // This is a standard response to writeAttributes operations
            // zigbee-clusters handles this automatically for built-in clusters,
            // but not for custom clusters like SonoffCluster
            this.debug(`SonoffCluster: Received writeAttributesResponse (cmdId 4) - attributes written successfully`);
            return; // Prevent "unknown command" error
        }
        
        // Handle protocolDataResponse (manufacturer-specific command 0x0B)
        if (frame.cmdId === 0x0B) {
            this.debug(`SonoffCluster: Received protocolDataResponse (cmdId 11)`);
            // Emit event so listener in device.js can process it
            this.emit('protocolDataResponse', { data: frame.data }, meta);
            return; // Prevent "unknown command" error
        }
        
        // For all other commands, use default handling
        return super.handleFrame(frame, meta);
    }
}

module.exports = SonoffCluster;
