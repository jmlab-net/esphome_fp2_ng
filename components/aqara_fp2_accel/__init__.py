import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import sensor
from esphome.const import (
    CONF_ID,
    DEVICE_CLASS_ILLUMINANCE,
    STATE_CLASS_MEASUREMENT,
    UNIT_LUX,
    ICON_BRIGHTNESS_5,
)

CONF_UPDATE_INTERVAL = "update_interval"
CONF_LIGHT_SENSOR = "light_sensor"

AUTO_LOAD = ["sensor"]

aqara_fp2_accel_ns = cg.esphome_ns.namespace("aqara_fp2_accel")
AqaraFP2Accel = aqara_fp2_accel_ns.class_(
    "AqaraFP2Accel", cg.Component
)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(AqaraFP2Accel),
        cv.Optional(CONF_UPDATE_INTERVAL, default="100ms"): cv.positive_time_period_milliseconds,
        cv.Optional(CONF_LIGHT_SENSOR): sensor.sensor_schema(
            unit_of_measurement=UNIT_LUX,
            icon=ICON_BRIGHTNESS_5,
            accuracy_decimals=1,
            device_class=DEVICE_CLASS_ILLUMINANCE,
            state_class=STATE_CLASS_MEASUREMENT,
        ),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    # Set update interval in milliseconds
    cg.add(var.set_update_interval(config[CONF_UPDATE_INTERVAL].total_milliseconds))

    if CONF_LIGHT_SENSOR in config:
        sens = await sensor.new_sensor(config[CONF_LIGHT_SENSOR])
        cg.add(var.set_light_sensor(sens))
