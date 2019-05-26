#!/usr/bin/env bash

nvm install 10
nvm use 10
npm install -g cordova ionic
ionic start CooclePhrotos tabs
cd CooclePhrotos
ionic cordova platform add ios
ionic cordova build ios
ionic cordova emulate ios