var gulp = require('gulp'),
    uglify = require('gulp-uglify'),
    concat = require('gulp-concat-util'),
    sass = require('gulp-sass')(require('sass')),
    sourcemaps = require('gulp-sourcemaps');

var oisvingSources = [
    './src/window.js',
    './src/OiSving.js',
    './src/OiSvingStorage.js',
    './src/OiSvingSound.js',
    './src/OiSvingTheming.js',
    './src/OiSvingFactory.js',
    './src/OiSvingConfig.js',
    './src/OiSvingUtility.js',
    './src/OiSvingMenu.js',
    './src/OiSvingGame.js',
    './src/OiSvingField.js',
    './src/OiSvingSuperpowerconfig.js',
    './src/OiSvingSuperpower.js',
    './src/OiSvingCurve.js',
    './src/OiSvingPoint.js',
    './src/OiSvingPlayer.js',
    './src/OiSvingLightbox.js',
    './src/OiSvingPiwik.js',
    './src/OiSvingPrivacypolicy.js',
];

var oisvingLibs = [
    './node_modules/pixi.js/dist/browser/pixi.js',
];

gulp.task('js', function(done) {
    gulp.src(oisvingLibs.concat(oisvingSources))
        .pipe(sourcemaps.init())
        .pipe(uglify({output: { comments: 'some'}}))
        .pipe(concat('oisving.min.js', {sep: ''}))
        .pipe(sourcemaps.write('.'))
        .pipe(gulp.dest('./dist/js/'))
        .on('end', done);
});

gulp.task('sass', function(done) {
    gulp.src('./scss/main.scss')
        .pipe(sass({errLogToConsole: true}))
        .pipe(gulp.dest('./dist/css/'))
        .on('end', done);
});

gulp.task('images', function () {
    return gulp.src('./images/*').pipe(gulp.dest('./dist/images'));
});

gulp.task('sound', function () {
    return gulp.src('./sound/**/*').pipe(gulp.dest('./dist/sound'));
});

gulp.task('build', gulp.series('js', 'sass', 'images', 'sound'));
gulp.task('default', gulp.series('build'));

gulp.task('watch', function() {
    gulp.watch([
        'src/*',
        'scss/*'
    ], gulp.series('build'))
});