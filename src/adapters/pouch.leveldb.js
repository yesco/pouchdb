/*globals extend: true, isDeleted: true, isLocalId: true */
/*globals Buffer: true */

'use strict';

var pouchdir = '../';
var Pouch = require(pouchdir + 'pouch.js');
var call = Pouch.utils.call;

// TODO: this adds the Math.uuid function used in pouch.utils
// possibly not the best place for it, but it works for now
require(pouchdir + 'deps/uuid.js');

var path = require('path');
var fs = require('fs');
var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;
var levelup = require('levelup');

var error = function(callback, message) {
  return process.nextTick(function() {
    callback({error: message});
  });
};

var DOC_STORE = 'document-store';
var BY_SEQ_STORE = 'by-sequence';
var ATTACH_STORE = 'attach-store';
var ATTACH_BINARY_STORE = 'attach-binary-store';

// leveldb barks if we try to open a db multiple times
// so we cache opened connections here for initstore()
var STORES = {};

// global store of change_emitter objects (one per db name)
// this allows replication to work by providing a db name as the src
var CHANGES = {};

// store the value of update_seq in the by-sequence store the key name will
// never conflict, since the keys in the by-sequence store are integers
var UPDATE_SEQ_KEY = '_local_last_update_seq';
var DOC_COUNT_KEY = '_local_doc_count';

function dbError(callback) {
  return function(err) {
    call(callback, {
      status: 500,
      error: err,
      reason: err.message
    });
  };
}

var LevelPouch = function(opts, callback) {
  var opened = false;
  var api = {};
  var update_seq = 0;
  var doc_count = 0;
  var stores = {};
  var name = opts.name;
  var change_emitter = CHANGES[name] || new EventEmitter();

  CHANGES[name] = change_emitter;

  function initstore(store_name, encoding) {
    var dbpath = path.resolve(path.join(opts.name, store_name));
    opts.valueEncoding = encoding || 'json';

    // createIfMissing = true by default
    opts.createIfMissing = opts.createIfMissing === undefined ?
      true : opts.createIfMissing;

    function setup_store(err, ldb) {
      if (stores.err) {
        return;
      }
      if (err) {
        stores.err = err;
        return call(callback, err);
      }

      stores[store_name] = ldb;
      STORES[dbpath] = ldb;

      if (!stores[DOC_STORE] ||
          !stores[BY_SEQ_STORE] ||
          !stores[ATTACH_STORE] ||
          !stores[ATTACH_BINARY_STORE]) {
        return;
      }

      update_seq = doc_count = -1;

      function finish() {
        if (doc_count >= 0 && update_seq >= 0) {
          opened = true;
          process.nextTick(function() { call(callback, null, api); });
        }
      }

      stores[BY_SEQ_STORE].get(DOC_COUNT_KEY, function(err, value) {
        if (!err) {
          doc_count = value;
        }
        else {
          doc_count = 0;
        }
        finish();
      });

      stores[BY_SEQ_STORE].get(UPDATE_SEQ_KEY, function(err, value) {
        if (!err) {
          update_seq = value;
        }
        else {
          update_seq = 0;
        }
        finish();
      });
    }

    if (STORES[dbpath] !== undefined) {
      setup_store(null, STORES[dbpath]);
    }
    else {
      levelup(dbpath, opts, setup_store);
    }
  }

  fs.stat(opts.name, function(err, stats) {
    function initstores() {
      initstore(DOC_STORE, 'json');
      initstore(BY_SEQ_STORE, 'json');
      initstore(ATTACH_STORE, 'json');
      initstore(ATTACH_BINARY_STORE, 'binary');
    }
    if (err && err.code === 'ENOENT') {
      // db directory doesn't exist
      fs.mkdir(opts.name, initstores);
    }
    else if (stats.isDirectory()) {
      initstores();
    }
    else {
      // error
    }
  });

  api.type = function() {
    return 'leveldb';
  };

  // the db's id is just the path to the leveldb directory
  api.id = function() {
    return opts.name;
  };

  api._info = function(callback) {
    return call(callback, null, {
      db_name: opts.name,
      doc_count: doc_count,
      update_seq: update_seq
    });
  };

  api._get = function(id, opts, callback) {
    stores[DOC_STORE].get(id.docId, function(err, metadata) {
      if (err || !metadata){
        return call(callback, Pouch.Errors.MISSING_DOC);
      }
      if (isDeleted(metadata) && !opts.rev) {
        return call(callback, Pouch.error(Pouch.Errors.MISSING_DOC, "deleted"));
      }

      var rev = Pouch.merge.winningRev(metadata);
      rev = opts.rev ? opts.rev : rev;
      var seq = metadata.rev_map[rev];

      stores[BY_SEQ_STORE].get(seq, function(err, doc) {
        if (!doc) {
          return call(callback, Pouch.Errors.MISSING_DOC);
        }

        doc._id = metadata.id;
        doc._rev = rev;

        if (opts.attachments && doc._attachments) {
          var attachments = Object.keys(doc._attachments);
          var recv = 0;

          attachments.forEach(function(key) {
            api.getAttachment(doc._id + '/' + key, {encode: true}, function(err, data) {
              doc._attachments[key].data = data;

              if (++recv === attachments.length) {
                callback(doc, metadata);
              }
            });
          });
        }
        else {
          if (doc._attachments){
            for (var key in doc._attachments) {
              doc._attachments[key].stub = true;
            }
          }
          callback(doc, metadata);
        }
      });
    });
  };

  // not technically part of the spec, but if putAttachment has its own method...
  api._getAttachment = function(id, opts, callback) {
    if (id.attachmentId === '') {
      return api.get(id, opts, callback);
    }

    stores[DOC_STORE].get(id.docId, function(err, metadata) {
      if (err) {
        return call(callback, err);
      }
      var seq = metadata.seq;
      stores[BY_SEQ_STORE].get(seq, function(err, doc) {
        if (err) {
          return call(callback, err);
        }
        var digest = doc._attachments[id.attachmentId].digest;
        var type = doc._attachments[id.attachmentId].content_type;

        stores[ATTACH_BINARY_STORE].get(digest, function(err, attach) {
          var data;

          if (err && err.name === 'NotFoundError') {
            // Empty attachment
            data = opts.encode ? '' : new Buffer('');
            return call(callback, null, data);
          }

          if (err) {
            return call(callback, err);
          }

          data = opts.encode ? btoa(attach) : attach;
          call(callback, null, data);
        });
      });
    });
  };

  api._bulkDocs = function(req, opts, callback) {

    var newEdits = opts.new_edits;
    var info = [];
    var docs = [];
    var results = [];

    // parse the docs and give each a sequence number
    var userDocs = req.docs;
    info = userDocs.map(function(doc, i) {
      var newDoc = Pouch.utils.parseDoc(doc, newEdits);
      newDoc._bulk_seq = i;
      if (newDoc.metadata && !newDoc.metadata.rev_map) {
        newDoc.metadata.rev_map = {};
      }
      return newDoc;
    });

    var infoErrors = info.filter(function(doc) {
      return doc.error;
    });
    if (infoErrors.length) {
      return call(callback, infoErrors[0]);
    }


    // group multiple edits to the same document
    info.forEach(function(info) {
      if (info.error) {
        return results.push(info);
      }
      if (!docs.length || !newEdits || info.metadata.id !== docs[docs.length-1].metadata.id) {
        return docs.push(info);
      }
      results.push(makeErr(Pouch.Errors.REV_CONFLICT, info._bulk_seq));
    });

    function processDocs() {
      if (docs.length === 0) {
        return complete();
      }
      var currentDoc = docs.pop();
      stores[DOC_STORE].get(currentDoc.metadata.id, function(err, oldDoc) {
        if (err && err.name === 'NotFoundError') {
          insertDoc(currentDoc, processDocs);
        }
        else {
          updateDoc(oldDoc, currentDoc, processDocs);
        }
      });
    }

    function insertDoc(doc, callback) {
      // Can't insert new deleted documents
      if ('was_delete' in opts && isDeleted(doc.metadata)) {
        results.push(makeErr(Pouch.Errors.MISSING_DOC, doc._bulk_seq));
        return callback();
      }
      doc_count++;
      writeDoc(doc, function() {
        stores[BY_SEQ_STORE].put(DOC_COUNT_KEY, doc_count, function(err) {
          if (err) {
            // TODO: handle error
          }
          return callback();
        });
      });
    }

    function updateDoc(oldDoc, docInfo, callback) {
      var merged = Pouch.merge(oldDoc.rev_tree, docInfo.metadata.rev_tree[0], 1000);

      var conflict = (isDeleted(oldDoc) && isDeleted(docInfo.metadata)) ||
        (!isDeleted(oldDoc) && newEdits && merged.conflicts !== 'new_leaf');

      if (conflict) {
        results.push(makeErr(Pouch.Errors.REV_CONFLICT, docInfo._bulk_seq));
        return callback();
      }

      docInfo.metadata.rev_tree = merged.tree;
      docInfo.metadata.rev_map = oldDoc.rev_map;
      writeDoc(docInfo, callback);
    }

    function writeDoc(doc, callback) {
      var err = null;
      var recv = 0;

      doc.data._id = doc.metadata.id;

      if (isDeleted(doc.metadata)) {
        doc.data._deleted = true;
      }

      var attachments = doc.data._attachments ?
        Object.keys(doc.data._attachments) :
        [];

      function collectResults(attachmentErr) {
        if (!err) {
          if (attachmentErr) {
            err = attachmentErr;
            call(callback, err);
          } else if (recv === attachments.length) {
            finish();
          }
        }
      }

      function attachmentSaved(err) {
        recv++;
        collectResults(err);
      }

      for (var i=0; i<attachments.length; i++) {
        var key = attachments[i];
        if (!doc.data._attachments[key].stub) {
          var data = doc.data._attachments[key].data;
          // if data is a string, it's likely to actually be base64 encoded
          if (typeof data === 'string') {
            data = Pouch.utils.atob(data);
          }
          var digest = 'md5-' + crypto.createHash('md5')
                .update(data || '')
                .digest('hex');
          delete doc.data._attachments[key].data;
          doc.data._attachments[key].digest = digest;
          saveAttachment(doc, digest, data, attachmentSaved);
        } else {
          recv++;
          collectResults();
        }
      }

      function finish() {
        update_seq++;
        doc.metadata.seq = doc.metadata.seq || update_seq;
        doc.metadata.rev_map[doc.metadata.rev] = doc.metadata.seq;

        stores[BY_SEQ_STORE].put(doc.metadata.seq, doc.data, function(err) {
          if (err) {
            return console.error(err);
          }

          stores[DOC_STORE].put(doc.metadata.id, doc.metadata, function(err) {
            results.push(doc);
            return saveUpdateSeq(callback);
          });
        });
      }

      if(!attachments.length) {
        finish();
      }
    }

    function saveUpdateSeq(callback) {
      stores[BY_SEQ_STORE].put(UPDATE_SEQ_KEY, update_seq, function(err) {
        if (err) {
          // TODO: handle error
        }
        return callback();
      });
    }

    function saveAttachment(docInfo, digest, data, callback) {
      stores[ATTACH_STORE].get(digest, function(err, oldAtt) {
        if (err && err.name !== 'NotFoundError') {
          if (Pouch.DEBUG) {
            console.error(err);
          }
          return call(callback, err);
        }

        var ref = [docInfo.metadata.id, docInfo.metadata.rev].join('@');
        var newAtt = {};

        if (oldAtt) {
          if (oldAtt.refs) {
            // only update references if this attachment already has them
            // since we cannot migrate old style attachments here without
            // doing a full db scan for references
            newAtt.refs = oldAtt.refs;
            newAtt.refs[ref] = true;
          }
        } else {
          newAtt.refs = {};
          newAtt.refs[ref] = true;
        }

        stores[ATTACH_STORE].put(digest, newAtt, function(err) {
          if (err) {
            return console.error(err);
          }
          // do not try to store empty attachments
          if (data.length === 0) {
            return callback(err);
          }
          stores[ATTACH_BINARY_STORE].put(digest, data, function(err) {
            callback(err);
            if (err) {
              return console.error(err);
            }
          });
        });
      });
    }

    function complete() {
      var aresults = [];
      results.sort(function(a, b) { return a._bulk_seq - b._bulk_seq; });

      results.forEach(function(result) {
        delete result._bulk_seq;
        if (result.error) {
          return aresults.push(result);
        }
        var metadata = result.metadata;
        var rev = Pouch.merge.winningRev(metadata);

        aresults.push({
          ok: true,
          id: metadata.id,
          rev: rev
        });

        if (Pouch.utils.isLocalId(metadata.id)) {
          return;
        }

        var change = {
          id: metadata.id,
          seq: metadata.seq,
          changes: Pouch.merge.collectLeaves(metadata.rev_tree),
          doc: result.data
        };
        change.doc._rev = rev;

        change_emitter.emit('change', change);
      });

      process.nextTick(function() { call(callback, null, aresults); });
    }

    function makeErr(err, seq) {
      err._bulk_seq = seq;
      return err;
    }

    processDocs();
  };

  api._allDocs = function(opts, callback) {

    var readstreamOpts = {
      reverse: false,
      start: '-1'
    };

    if ('startkey' in opts && opts.startkey) {
      readstreamOpts.start = opts.startkey;
    }
    if ('endkey' in opts && opts.endkey) {
      readstreamOpts.end = opts.endkey;
    }
    if ('descending' in opts && opts.descending) {
      readstreamOpts.reverse = true;
    }

    var results = [];
    var resultsMap = {};
    var docstream = stores[DOC_STORE].readStream(readstreamOpts);
    docstream.on('data', function(entry) {
      function allDocsInner(metadata, data) {
        if (Pouch.utils.isLocalId(metadata.id)) {
          return;
        }
        var doc = {
          id: metadata.id,
          key: metadata.id,
          value: {
            rev: Pouch.merge.winningRev(metadata)
          }
        };
        if (opts.include_docs) {
          doc.doc = data;
          doc.doc._rev = doc.value.rev;
          if (opts.conflicts) {
            doc.doc._conflicts = Pouch.merge.collectConflicts(metadata);
          }
        }
        if ('keys' in opts) {
          if (opts.keys.indexOf(metadata.id) > -1) {
            if (isDeleted(metadata)) {
              doc.value.deleted = true;
              doc.doc = null;
            }
            resultsMap[doc.id] = doc;
          }
        } else {
          if(!isDeleted(metadata)) {
            results.push(doc);
          }
        }
      }
      var metadata = entry.value;
      if (opts.include_docs) {
        var seq = metadata.rev_map[Pouch.merge.winningRev(metadata)];
        stores[BY_SEQ_STORE].get(seq, function(err, data) {
          allDocsInner(metadata, data);
        });
      }
      else {
        allDocsInner(metadata);
      }
    });
    docstream.on('error', function(err) {
      // TODO: handle error
      console.error(err);
    });
    docstream.on('end', function() {
    });
    docstream.on('close', function() {
      if ('keys' in opts) {
        opts.keys.forEach(function(key) {
          if (key in resultsMap) {
            results.push(resultsMap[key]);
          } else {
            results.push({"key": key, "error": "not_found"});
          }
        });
        if (opts.descending) {
          results.reverse();
        }
      }
      return call(callback, null, {
        total_rows: results.length,
        rows: results
      });
    });
  };

  api._changes = function(opts) {

    var descending = 'descending' in opts ? opts.descending : false;
    var results = [];
    var changeListener;

    function fetchChanges() {
      var streamOpts = {
        reverse: descending
      };

      if (!streamOpts.reverse) {
        streamOpts.start = opts.since ? opts.since + 1 : 0;
      }

      if (opts.limit) {
        streamOpts.limit = opts.limit;
      }

      var changeStream = stores[BY_SEQ_STORE].readStream(streamOpts);
      changeStream
        .on('data', function(data) {
          if (Pouch.utils.isLocalId(data.key)) {
            return;
          }

          stores[DOC_STORE].get(data.value._id, function(err, metadata) {
            if (Pouch.utils.isLocalId(metadata.id)) {
              return;
            }

            var change = {
              id: metadata.id,
              seq: metadata.seq,
              changes: Pouch.merge.collectLeaves(metadata.rev_tree)
                .map(function(x) { return {rev: x.rev}; }),
              doc: data.value
            };

            change.doc._rev = Pouch.merge.winningRev(metadata);

           if (isDeleted(metadata)) {
              change.deleted = true;
            }
            if (opts.conflicts) {
              change.doc._conflicts = Pouch.merge.collectConflicts(metadata);
            }

            // Ensure duplicated dont overwrite winning rev
            if (+data.key === metadata.rev_map[change.doc._rev]) {
              results.push(change);
            }
          });
        })
        .on('error', function(err) {
          // TODO: handle errors
          console.error(err);
        })
        .on('close', function() {
          changeListener = Pouch.utils.filterChange(opts);
          if (opts.continuous && !opts.cancelled) {
            change_emitter.on('change', changeListener);
          }
          // filters changes in-place, calling opts.onChange on matching changes
          results.map(Pouch.utils.filterChange(opts));
          call(opts.complete, null, {results: results});
        });
    }

    // fetch a filter from a design doc
    if (opts.filter && typeof opts.filter === 'string') {
      var filtername = opts.filter.split('/');
      api.get('_design/'+filtername[0], function(err, design) {
        /*jshint evil: true */
        var filter = eval('(function() { return ' +
                          design.filters[filtername[1]] + '})()');
        opts.filter = filter;
        fetchChanges();
      });
    }
    else {
      fetchChanges();
    }

    if (opts.continuous) {
      return {
        cancel: function() {
          if (Pouch.DEBUG) {
            console.log(name + ': Cancel Changes Feed');
          }
          opts.cancelled = true;
          change_emitter.removeListener('change', changeListener);
        }
      };
    }
  };

  api._close = function(callback) {
    if (!opened) {
      return call(callback, Pouch.Errors.NOT_OPEN);
    }

    var dbpath = path.resolve(opts.name);
    var stores = [
      path.join(dbpath, DOC_STORE),
      path.join(dbpath, BY_SEQ_STORE),
      path.join(dbpath, ATTACH_STORE),
      path.join(dbpath, ATTACH_BINARY_STORE)
    ];
    var closed = 0;
    stores.map(function(path) {
      var store = STORES[path];
      if (store) {
        store.close(function() {
          delete STORES[path];

          if (++closed >= stores.length) {
            done();
          }
        });
      }
      else {
        if (++closed >= stores.length) {
          done();
        }
      }
    });

    function done() {
      call(callback, null);
    }
  };

  // compaction internal functions
  api._getRevisionTree = function(docId, callback){
    stores[DOC_STORE].get(docId, function(err, metadata) {
      if (err) {
        call(callback, Pouch.Errors.MISSING_DOC);
      } else {
        call(callback, null, metadata.rev_tree);
      }
    });
  };

  api._removeDocRevisions = function(docId, revs, callback) {
    if (!revs.length) {
      callback();
    }
    stores[DOC_STORE].get(docId, function(err, metadata) {
      var seqs = metadata.rev_map; // map from rev to seq
      var count = revs.count;

      function done() {
        count--;
        if (!count) {
          callback();
        }
      }

      revs.forEach(function(rev) {
        var seq = seqs[rev];
        if (!seq) {
          done();
          return;
        }
        stores[BY_SEQ_STORE].del(seq, function(err) {
          done();
        });
      });
    });
  };
  // end of compaction internal functions

  return api;
};

LevelPouch.valid = function() {
  return typeof module !== undefined && module.exports;
};

// recursive fs.rmdir for Pouch.destroy. Use with care.
function rmdir(dir, callback) {
  fs.readdir(dir, function rmfiles(err, files) {
    if (err) {
      if (err.code === 'ENOTDIR') {
        return fs.unlink(dir, callback);
      }
      else if (callback) {
        return callback(err);
      }
      else {
        return;
      }
    }
    var count = files.length;
    if (count === 0) {
      return fs.rmdir(dir, callback);
    }
    files.forEach(function(file) {
      var todel = path.join(dir, file);
      rmdir(todel, function(err) {
        count--;
        if (count <= 0) {
          fs.rmdir(dir, callback);
        }
      });
    });
  });
}

// close and delete open leveldb stores
LevelPouch.destroy = function(name, callback) {
  var dbpath = path.resolve(name);
  var stores = [
    path.join(dbpath, DOC_STORE),
    path.join(dbpath, BY_SEQ_STORE),
    path.join(dbpath, ATTACH_STORE),
    path.join(dbpath, ATTACH_BINARY_STORE)
  ];
  var closed = 0;
  stores.map(function(path) {
    var store = STORES[path];
    if (store) {
      store.close(function() {
        delete STORES[path];

        if (++closed >= stores.length) {
          done();
        }
      });
    }
    else {
      if (++closed >= stores.length) {
        done();
      }
    }
  });

  function done() {
    rmdir(name, function(err) {
      if (err && err.code === 'ENOENT') {
        // TODO: MISSING_DOC name is somewhat misleading in this context
        return call(callback, Pouch.Errors.MISSING_DOC);
      }
      return call(callback, err);
    });
  }
};

Pouch.adapter('ldb', LevelPouch);
Pouch.adapter('leveldb', LevelPouch);

module.exports = LevelPouch;
