/*
seek-bzip - a pure-javascript module for seeking within bzip2 data

Copyright (C) 2013 C. Scott Ananian
Copyright (C) 2012 Eli Skeggs
Copyright (C) 2011 Kevin Kwok

This library is free software; you can redistribute it and/or
modify it under the terms of the GNU Lesser General Public
License as published by the Free Software Foundation; either
version 2.1 of the License, or (at your option) any later version.

This library is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
Lesser General Public License for more details.

You should have received a copy of the GNU Lesser General Public
License along with this library; if not, see
http://www.gnu.org/licenses/lgpl-2.1.html

Adapted from node-bzip, copyright 2012 Eli Skeggs.
Adapted from bzip2.js, copyright 2011 Kevin Kwok (antimatter15@gmail.com).

Based on micro-bunzip by Rob Landley (rob@landley.net).

Based on bzip2 decompression code by Julian R Seward (jseward@acm.org),
which also acknowledges contributions by Mike Burrows, David Wheeler,
Peter Fenwick, Alistair Moffat, Radford Neal, Ian H. Witten,
Robert Sedgewick, and Jon L. Bentley.
*/

var BitReader = require('./bitreader');

var MAX_HUFCODE_BITS = 20;
var MAX_SYMBOLS = 258;
var SYMBOL_RUNA = 0;
var SYMBOL_RUNB = 1;
var GROUP_SIZE = 50;

var WHOLEPI = "314159265359";
var SQRTPI = "177245385090";

var mtf = function(array, index) {
  var src = array[index];
  for (var i = index; i > 0;)
    array[i] = array[--i];
  return array[0] = src;
};

var decode = function(inputbuffer, outputsize) {
  // this is the start_bunzip function from micro-bunzip:
  /* Ensure that file starts with "BZh['1'-'9']." */
  if (inputbuffer.toString(null, 0, 3) !== 'BZh')
    throw new TypeError('improper format');
  var level = inputbuffer[3] - 0x30;
  if (level < 1 || level > 9)
    throw new TypeError('level out of range');
  var reader = new BitReader(inputbuffer, 4);

  /* Fourth byte (ascii '1'-'9'), indicates block size in units of 100k of
     uncompressed data.  Allocate intermediate buffer for block. */
  var bufsize = 100000 * level;
  var output = outputsize ? new Buffer(outputsize) : '';
  var nextoutput = 0;
  for (;;) {
    // this is get_next_block() function from micro-bunzip:
    /* Read in header signature and CRC, then validate signature.
       (last block signature means CRC is for whole file, return now) */
    var h = reader.pi();
    if (h === SQRTPI) { // last block
      if (outputsize && nextoutput !== outputsize)
        throw new TypeError('outputsize does not match decoded input');
      return outputsize ? output : new Buffer(output);
    }
    if (h !== WHOLEPI)
      throw new TypeError('malformed bzip data');
    reader.read(32); // ignoring CRC codes; is this wise?
    /* We can add support for blockRandomised if anybody complains.  There was
       some code for this in busybox 1.0.0-pre3, but nobody ever noticed that
       it didn't actually work. */
    if (reader.read(1))
      throw new TypeError('unsupported bzip version');
    var origPointer = reader.read(24);
    if (origPointer > bufsize)
      throw new TypeError('initial position out of bounds');
    /* mapping table: if some byte values are never used (encoding things
       like ascii text), the compression code removes the gaps to have fewer
       symbols to deal with, and writes a sparse bitfield indicating which
       values were present.  We make a translation table to convert the symbols
       back to the corresponding bytes. */
    var t = reader.read(16);
    var symToByte = new Buffer(256), symTotal = 0;
    for (var i = 0; i < 16; i++) {
      if (t & (1 << (0xF - i))) {
        var k = reader.read(16), o = i * 16;
        for (var j = 0; j < 16; j++)
          if (k & (1 << (0xF - j)))
            symToByte[symTotal++] = o + j;
      }
    }

    /* How many different huffman coding groups does this block use? */
    var groupCount = reader.read(3);
    if (groupCount < 2 || groupCount > 6)
      throw new TypeError('malformed bzip data');
    /* nSelectors: Every GROUP_SIZE many symbols we select a new huffman coding
       group.  Read in the group selector list, which is stored as MTF encoded
       bit runs.  (MTF=Move To Front, as each value is used it's moved to the
       start of the list.) */
    var nSelectors = reader.read(15);
    if (nSelectors === 0)
      throw new TypeError('malformed bzip data');

    var mtfSymbol = []; // TODO: possibly replace with buffer?
    for (var i = 0; i < groupCount; i++)
      mtfSymbol[i] = i;

    var selectors = new Buffer(nSelectors); // was 32768...

    for (var i = 0; i < nSelectors; i++) {
      /* Get next value */
      for (var j = 0; reader.read(1); j++)
        if (j >= groupCount)
          throw new TypeError('malformed bzip data');
      /* Decode MTF to get the next selector */
      selectors[i] = mtf(mtfSymbol, j);
    }

    /* Read the huffman coding tables for each group, which code for symTotal
       literal symbols, plus two run symbols (RUNA, RUNB) */
    var symCount = symTotal + 2;
    var groups = [];
    for (var j = 0; j < groupCount; j++) {
      var length = new Buffer(symCount), temp = new Buffer(MAX_HUFCODE_BITS + 1);
      /* Read huffman code lengths for each symbol.  They're stored in
         a way similar to mtf; record a starting value for the first symbol,
         and an offset from the previous value for everys symbol after that. */
      t = reader.read(5); // lengths
      for (var i = 0; i < symCount; i++) {
        for (;;) {
          if (t < 1 || t > MAX_HUFCODE_BITS)
            throw new TypeError('malformed bzip data');
          /* If first bit is 0, stop.  Else second bit indicates whether
             to increment or decrement the value. */
          if(!reader.read(1))
            break;
          if(!reader.read(1))
            t++;
          else
            t--;
        }
        length[i] = t;
      }

      /* Find largest and smallest lengths in this group */
      var minLen,  maxLen;
      minLen = maxLen = length[0];
      for (var i = 1; i < symCount; i++) {
        if (length[i] > maxLen)
          maxLen = length[i];
        else if (length[i] < minLen)
          minLen = length[i];
      }

      /* Calculate permute[], base[], and limit[] tables from length[].
       *
       * permute[] is the lookup table for converting huffman coded symbols
       * into decoded symbols.  base[] is the amount to subtract from the
       * value of a huffman symbol of a given length when using permute[].
       *
       * limit[] indicates the largest numerical value a symbol with a given
       * number of bits can have.  This is how the huffman codes can vary in
       * length: each code with a value>limit[length] needs another bit.
       */
      var hufGroup = {};
      groups.push(hufGroup);
      hufGroup.permute = new Array(MAX_SYMBOLS); // UInt32Array
      hufGroup.limit = new Array(MAX_HUFCODE_BITS + 2); // UInt32Array
      hufGroup.base = new Array(MAX_HUFCODE_BITS + 1); // UInt32Array
      hufGroup.minLen = minLen;
      hufGroup.maxLen = maxLen;
      /* Calculate permute[].  Concurently, initialize temp[] and limit[]. */
      var pp = 0, i;
      for (i = minLen; i <= maxLen; i++) {
        temp[i] = hufGroup.limit[i] = 0;
        for (t = 0; t < symCount; t++)
          if (length[t] === i)
            hufGroup.permute[pp++] = t;
      }
      /* Count symbols coded for at each bit length */
      for (i = 0; i < symCount; i++)
        temp[length[i]]++;
      /* Calculate limit[] (the largest symbol-coding value at each bit
       * length, which is (previous limit<<1)+symbols at this level), and
       * base[] (number of symbols to ignore at each bit length, which is
       * limit minus the cumulative count of symbols coded for already). */
      pp = t = 0;
      for (i = minLen; i < maxLen; i++) {
        pp += temp[i];
        /* We read the largest possible symbol size and then unget bits
           after determining how many we need, and those extra bits could
           be set to anything.  (They're noise from future symbols.)  At
           each level we're really only interested in the first few bits,
           so here we set all the trailing to-be-ignored bits to 1 so they
           don't affect the value>limit[length] comparison. */
        hufGroup.limit[i + 1] = pp - 1;
        pp <<= 1;
        t += temp[i];
        hufGroup.base[i + 2] = pp - t;
      }
      hufGroup.limit[maxLen + 2] = Number.MAX_VALUE; /* Sentinal value for reading next sym. */
      hufGroup.limit[maxLen + 1] = pp + temp[maxLen] - 1;
      hufGroup.base[minLen + 1] = 0;
    }
    /* We've finished reading and digesting the block header.  Now read this
       block's huffman coded symbols from the file and undo the huffman coding
       and run length encoding, saving the result into dbuf[dbufCount++]=uc */

    /* Initialize symbol occurrence counters and symbol Move To Front table */
    var byteCount = new Uint32Array(256); // Uint32Array
    for (var i = 0; i < 256; i++)
      mtfSymbol[i] = i;
    /* Loop through compressed symbols. */
    var runPos = 0, count = 0, symCount = 0, selector = 0, uc;
    var buf = new Array(bufsize); // Uint32Array
    for (;;) {
      /* Determine which huffman coding group to use. */
      if (!(symCount--)) {
        symCount = GROUP_SIZE - 1;
        if (selector >= nSelectors)
          throw new TypeError('malformed bzip data');
        hufGroup = groups[selectors[selector++]];
      }
      /* Read next huffman-coded symbol. */
      i = hufGroup.minLen
      j = reader.read(i);
      for (;;i++) {
        if (i > hufGroup.maxLen)
          throw new TypeError('malformed bzip data');
        if (j <= hufGroup.limit[i + 1])
          break;
        j = (j << 1) | reader.read(1);
      }
      /* Huffman decode value to get nextSym (with bounds checking) */
      j -= hufGroup.base[i + 1];
      if (j < 0 || j >= MAX_SYMBOLS)
        throw new TypeError('malformed bzip data');
      var nextSym = hufGroup.permute[j];
      /* We have now decoded the symbol, which indicates either a new literal
         byte, or a repeated run of the most recent literal byte.  First,
         check if nextSym indicates a repeated run, and if so loop collecting
         how many times to repeat the last literal. */
      if (nextSym === SYMBOL_RUNA || nextSym === SYMBOL_RUNB) {
        /* If this is the start of a new run, zero out counter */
        if (!runPos){
          runPos = 1;
          t = 0;
        }
        /* Neat trick that saves 1 symbol: instead of or-ing 0 or 1 at
           each bit position, add 1 or 2 instead.  For example,
           1011 is 1<<0 + 1<<1 + 2<<2.  1010 is 2<<0 + 2<<1 + 1<<2.
           You can make any bit pattern that way using 1 less symbol than
           the basic or 0/1 method (except all bits 0, which would use no
           symbols, but a run of length 0 doesn't mean anything in this
           context).  Thus space is saved. */
        if (nextSym === SYMBOL_RUNA)
          t += runPos;
        else
          t += 2 * runPos;
        runPos <<= 1;
        continue;
      }
      /* When we hit the first non-run symbol after a run, we now know
         how many times to repeat the last literal, so append that many
         copies to our buffer of decoded symbols (dbuf) now.  (The last
         literal used is the one at the head of the mtfSymbol array.) */
      if (runPos){
        runPos = 0;
        if (count + t >= bufsize)
          throw new TypeError('malformed bzip data');
        uc = symToByte[mtfSymbol[0]];
        byteCount[uc] += t;
        while (t--)
          buf[count++] = uc;
      }
      /* Is this the terminating symbol? */
      if (nextSym > symTotal)
        break;
      /* At this point, nextSym indicates a new literal character.  Subtract
         one to get the position in the MTF array at which this literal is
         currently to be found.  (Note that the result can't be -1 or 0,
         because 0 and 1 are RUNA and RUNB.  But another instance of the
         first symbol in the mtf array, position 0, would have been handled
         as part of a run above.  Therefore 1 unused mtf position minus
         2 non-literal nextSym values equals -1.) */
      if (count >= bufsize)
        throw new TypeError('malformed bzip data');
      i = nextSym - 1;
      uc = mtfSymbol[i];
      /* Adjust the MTF array.  Since we typically expect to move only a
       * small number of symbols, and are bound by 256 in any case, using
       * memmove here would typically be bigger and slower due to function
       * call overhead and other assorted setup costs. */
      mtfSymbol.splice(i, 1);
      mtfSymbol.splice(0, 0, uc);
      uc = symToByte[uc];
      /* We have our literal byte.  Save it into dbuf. */
      byteCount[uc]++;
      buf[count++] = uc;
    }
    /* At this point, we've read all the huffman-coded symbols (and repeated
          runs) for this block from the input stream, and decoded them into the
       intermediate buffer.  There are dbufCount many decoded bytes in dbuf[].
       Now undo the Burrows-Wheeler transform on dbuf.
       See http://dogma.net/markn/articles/bwt/bwt.htm
     */
    if (origPointer < 0 || origPointer >= count)
      throw new TypeError('malformed bzip data');
    /* Turn byteCount into cumulative occurrence counts of 0 to n-1. */
    var j = 0;
    for (var i = 0; i < 256; i++) {
      k = j + byteCount[i];
      byteCount[i] = j;
      j = k;
    }
    /* Figure out what order dbuf would be in if we sorted it. */
    for (var i = 0; i < count; i++) {
      uc = buf[i] & 0xff;
      buf[byteCount[uc]] |= (i << 8);
      byteCount[uc]++;
    }
    /* Decode first byte by hand to initialize "previous" byte.  Note that it
       doesn't get output, and if the first three characters are identical
       it doesn't qualify as a run (hence writeRunCountdown=5). */
    var pos = 0, current = 0, run = 0;
    if (count) {
      pos = buf[origPointer];
      current = (pos & 0xff);
      pos >>= 8;
      run = -1;
    }
    //count = count;

    // end of get_next_block() ---------------------
    // start of read_bunzip()  ---------------------

    var copies, previous, outbyte;
    while (count) {
      count--;
      previous = current;
      pos = buf[pos];
      current = pos & 0xff;
      pos >>= 8;
      if (run++ === 3){
        copies = current;
        outbyte = previous;
        current = -1;
      } else {
        copies = 1;
        outbyte = current;
      }
      if (outputsize)
        while (copies--)
          output[nextoutput++] = outbyte;
      else
        while (copies--)
          output += String.fromCharCode(outbyte);
      if (current != previous)
        run = 0;
    }
  }
};

module.exports = decode;
