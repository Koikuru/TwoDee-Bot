﻿var fs = require('fs');
var request = require('request');
var azure = require('azure');
var url = require('url');
var csv = require('csv');
var spawn = require('child_process').spawn;
var BufferStream = require('../BufferStream');
var config = JSON.parse(fs.readFileSync(__dirname + '/../config.json', { encoding: 'utf8' }));
var Q = require('q');

function createThumbnail(req) {
	var conv = spawn(config.convertPath, ['-', '-thumbnail', '200x200', 'jpg:-']);
	req.pipe(conv.stdin);

	var def = Q.defer();
	var thumbnail = new Buffer(0);
	conv.stdout.on('data', function (data) {
		thumbnail = Buffer.concat([thumbnail, data]);
	});
	conv.stdout.on('error', function (err) {
		def.reject(err);
	});
	conv.stdout.on('end', function () {
		def.resolve(thumbnail);
	});

	return def.promise;
}

module.exports = function (client) {

	if (!process.env.AZURE_STORAGE_ACCOUNT || !process.env.AZURE_STORAGE_ACCESS_KEY) {
		var userData = JSON.parse(fs.readFileSync(__dirname + '/.azure', { encoding: 'utf8' }));

		if (!userData.name) {
			return {};
		}
		process.env.AZURE_STORAGE_ACCOUNT = userData.name;
		process.env.AZURE_STORAGE_ACCESS_KEY = userData.key;
	}

	var tableService = azure.createTableService();
	tableService.createTableIfNotExists('images', function () { });
	var blobService = azure.createBlobService();
	blobService.createContainerIfNotExists('images', { publicAccessLevel: 'blob' }, function () { });
	blobService.createContainerIfNotExists('thumbnails', { publicAccessLevel: 'blob' }, function () { });

	function checkLink(url, fn) {
		return Q.ninvoke(request, 'head', { url: url, headers: { Referer: url } }).then(function (resp) {
			if (resp.statusCode >= 300 || resp.statusCode < 200) throw new Error('Unsuccessful http request');

			return resp;
		});
	}

	function saveLink(url) {
		var date = new Date();
		var partKey = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()).toString();
		var blobId = Date.now().toString();

		checkLink(url).then(function (resp) {
			var query = azure.TableQuery
				.select('RowKey')
				.from('images')
				.where('Url eq ?', url);

			return Q.ninvoke(tableService, 'queryEntities', query);
		}).spread(function (entities) {
			if (entities.length) throw new Error('Entry already exists');

			var req = request.get({ url: url, headers: { Referer: url } });

			req.once('response', function (resp) {
				var imgDeferred = Q.defer();
				blobService.createBlockBlobFromStream('images', blobId.toString(), resp, resp.headers['content-length'], { contentType: resp.headers['content-type'], cacheControl: 'max-age=31536000, public' }, function (err) {
					if (err) {
						imgDeferred.reject(err);
					} else {
						imgDeferred.resolve();
					}
				});


				var thumbPromise = createThumbnail(req).then(function (thumbnail) {
					return Q.ninvoke(blobService, 'createBlockBlobFromStream', 'thumbnails', blobId.toString(), new BufferStream(thumbnail), thumbnail.length, { contentType: 'image/jpeg', cacheControl: 'max-age=31536000, public' });
				});

				Q.all([imgDeferred.promise, thumbPromise]).then(function () {
					return Q.ninvoke(tableService, 'insertEntity', 'images', {
						PartitionKey: partKey,
						RowKey: blobId,
						Url: url
					});
				}).then(function () {
					client.emit('azure:image', blobId, partKey);
				});
			});
		});
	}

	function savePixiv(id) {
		request('http://spapi.pixiv.net/iphone/illust.php?illust_id=' + id, function (err, r, data) {
			if (err) return;

			csv().from.string(data).to.array(function (arr) {
				arr = arr[0];
				if (arr[4].length === 1) arr[4] = '0' + arr[4];

				saveLink('http://i1.pixiv.net/img' + arr[4] + '/img/' + arr[24] + '/' + arr[0] + '.' + arr[2]);
			});
		});
	}

	function parseLinks(message) {
		var re, match;

		re = /http:\/\/e-shuushuu.net\/images\/\S+/gi;
		while (match = re.exec(message)) {
			saveLink(match[0]);
		}

		re = /https?:\/\/(www\.|i\.)?imgur.com\/(\w+)/gi;
		while (match = re.exec(message)) {
			saveLink('http://i.imgur.com/' + match[2] + '.jpg');
		}

		re = /https?:\/\/(www.)?pixiv.net\/member_illust.php\?((.+)&)?illust_id=([\d]+)/gi;
		while (match = re.exec(message)) {
			if (match[4]) {
				savePixiv(match[4]);
			}
		}
	}

	client.on('commands:message', function (image) {
		parseLinks(image.message);
	});

	client.on('commands:image', function (image) {
		saveLink(image.image);
	});

	return {
		messageHandler: function (from, channel, message) {
			parseLinks(message);
		}
	};
};